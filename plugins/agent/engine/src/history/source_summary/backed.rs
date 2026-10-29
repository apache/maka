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

//! Intrinsically oversized summary state in the same request's append-only arena.
use super::*;
use crate::history::{
    capture_arena::CaptureArena,
    serialize_source::{ArenaEmit, AsyncEmit},
};
use sha2::{Digest, Sha256};
use std::ops::Range;

#[derive(Clone)]
struct OwnedArena {
    arena: CaptureArena,
    owner: Arc<Owner>,
}
impl OwnedArena {
    async fn with_writer<T: Send + 'static>(
        &self,
        write: impl FnOnce(&mut crate::history::request_backing::RequestBackingBuilder) -> io::Result<T>
        + Send
        + 'static,
    ) -> io::Result<T> {
        let owner = self.owner.clone();
        self.arena
            .with_writer(move |builder| {
                let _owner = owner;
                write(builder)
            })
            .await
    }
    fn pending(&self, range: Range<u64>) -> SourceBytes {
        SourceBytes::Source(Arc::new(OwnedSource {
            bytes: self.arena.pending(range),
            owner: self.owner.clone(),
        }))
    }
    async fn append(
        &self,
        source: SourceBytes,
        budget: Arc<dyn SourceBudget>,
        cancel: &CancellationToken,
    ) -> io::Result<Range<u64>> {
        let mut sink =
            ArenaEmit::new_owned(self.arena.clone(), &budget, cancel, self.owner.clone()).await?;
        let start = sink.position();
        let mut cursor = source.open(budget.clone());
        let mut buffer = budget.allocate(4096).await?;
        loop {
            let read = cursor
                .read_chunk(buffer.retain_owner(self.owner.clone()))
                .await?;
            sink.write(&read.buffer.as_ref()[..read.bytes_read]).await?;
            buffer = read.buffer;
            if read.eof {
                break;
            }
            if read.bytes_read == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "summary label source made no progress",
                ));
            }
        }
        let end = sink.position();
        sink.finish().await?;
        Ok(start..end)
    }
}
struct OwnedSource {
    bytes: SourceBytes,
    owner: Arc<Owner>,
}
impl ByteSource for OwnedSource {
    fn len(&self) -> Option<u64> {
        self.bytes.len()
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        Ok(Arc::new(Self {
            bytes: self.bytes.slice(range)?,
            owner: self.owner.clone(),
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(OwnedCursor {
            cursor: self.bytes.open(budget),
            owner: self.owner.clone(),
        })
    }
}
struct OwnedCursor {
    cursor: Box<dyn ByteCursor>,
    owner: Arc<Owner>,
}
impl ByteCursor for OwnedCursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut read = self
                .cursor
                .read_chunk(buffer.retain_owner(self.owner.clone()))
                .await?;
            read.buffer = read.buffer.retain_owner(self.owner.clone());
            Ok(read)
        })
    }
}

const MEDIA_BYTES: u64 = 64;
const SYSTEM_BYTES: u64 = 40;
const HASH_BYTES: u64 = 32;
const COMPOSITE_PIECES: usize = 3;
const EXCERPT_PIECES: usize = 2 * COMPOSITE_PIECES + 1;
const TEXT_PIECES: usize = 1 + 1 + 3 + 7 + 3 * EXCERPT_PIECES;
const RANGE_SOURCES: usize = 2 * COMPOSITE_PIECES + 2 + 1;
#[derive(Clone, Copy)]
struct MediaRecord {
    message: u64,
    outer: u64,
    content: u64,
    kind: u64,
    label_start: u64,
    label_bytes: u64,
    label_prefix: u64,
    token_prefix: u64,
}
impl MediaRecord {
    fn encode(self) -> [u8; MEDIA_BYTES as usize] {
        let mut bytes = [0; MEDIA_BYTES as usize];
        for (slot, value) in bytes.as_chunks_mut::<8>().0.iter_mut().zip([
            self.message,
            self.outer,
            self.content,
            self.kind,
            self.label_start,
            self.label_bytes,
            self.label_prefix,
            self.token_prefix,
        ]) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }
    fn decode(bytes: [u8; MEDIA_BYTES as usize]) -> Self {
        let mut values = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|bytes| u64::from_le_bytes(*bytes));
        Self {
            message: values.next().expect("message word"),
            outer: values.next().expect("outer word"),
            content: values.next().expect("content word"),
            kind: values.next().expect("kind word"),
            label_start: values.next().expect("label start word"),
            label_bytes: values.next().expect("label length word"),
            label_prefix: values.next().expect("label prefix word"),
            token_prefix: values.next().expect("token prefix word"),
        }
    }
}
#[derive(Clone)]
struct Tables {
    media: Range<u64>,
    systems: Range<u64>,
    prefixes: Range<u64>,
}
fn offset(start: u64, index: usize, width: u64) -> io::Result<u64> {
    start
        .checked_add(
            u64::try_from(index)
                .map_err(io::Error::other)?
                .checked_mul(width)
                .ok_or_else(overflow)?,
        )
        .ok_or_else(overflow)
}
async fn read<const N: usize>(arena: &OwnedArena, position: u64) -> io::Result<[u8; N]> {
    arena
        .arena
        .read_control_owned::<N>(position, arena.owner.clone())
        .await
}

async fn write<const N: usize>(
    arena: &OwnedArena,
    position: u64,
    bytes: [u8; N],
) -> io::Result<()> {
    arena
        .with_writer(move |writer| writer.write_at(position, &bytes))
        .await
}
async fn media_record(
    arena: &OwnedArena,
    tables: &Tables,
    index: usize,
) -> io::Result<MediaRecord> {
    Ok(MediaRecord::decode(
        read(arena, offset(tables.media.start, index, MEDIA_BYTES)?).await?,
    ))
}
async fn reserve(arena: &OwnedArena, length: u64, _fit: &Fit<'_>) -> io::Result<Range<u64>> {
    arena
        .with_writer(move |writer| writer.reserve_zeroed(length))
        .await
}
struct Index<'a> {
    source: &'a Arc<dyn MessageSource>,
    arena: &'a OwnedArena,
    tables: Tables,
    fit: &'a Fit<'a>,
    media: usize,
    systems: usize,
    label_prefix: u64,
    token_prefix: u64,
    system_breakdown: maka_agent_facts::context::PreparedContextBreakdown,
    hash: Sha256,
}
impl Index<'_> {
    async fn content(
        &mut self,
        content: &Arc<dyn RecipeSource<ContentRecipe>>,
        message: usize,
        outer: usize,
        kind: u64,
    ) -> io::Result<()> {
        let mut cursor = content.open(0);
        let mut index = 0usize;
        while let Some(part) = cursor.next().await? {
            if matches!(part, ContentRecipe::Media { .. }) {
                let label = self.fit.label(message, index, &part)?;
                let range = self
                    .arena
                    .append(
                        text::bytes(label, self.fit.budget.clone()),
                        self.fit.budget.clone(),
                        self.fit.cancel,
                    )
                    .await?;
                let length = range.end - range.start;
                self.label_prefix = self.label_prefix.checked_add(length).ok_or_else(overflow)?;
                self.token_prefix = self
                    .token_prefix
                    .checked_add(1024)
                    .and_then(|total| total.checked_add(length.div_ceil(3)))
                    .ok_or_else(overflow)?;
                let record = MediaRecord {
                    message: message as u64,
                    outer: outer as u64,
                    content: index as u64,
                    kind,
                    label_start: range.start,
                    label_bytes: length,
                    label_prefix: self.label_prefix,
                    token_prefix: self.token_prefix,
                };
                write(
                    self.arena,
                    offset(self.tables.media.start, self.media, MEDIA_BYTES)?,
                    record.encode(),
                )
                .await?;
                self.media = self.media.checked_add(1).ok_or_else(overflow)?;
            }
            index = index.checked_add(1).ok_or_else(overflow)?;
        }
        Ok(())
    }
    async fn build(&mut self) -> io::Result<()> {
        write::<32>(
            self.arena,
            self.tables.prefixes.start,
            self.hash.clone().finalize().into(),
        )
        .await?;
        let mut cursor = self.source.open(0);
        let mut message = 0usize;
        while let Some(recipe) = cursor.next().await? {
            if self.fit.cancel.is_cancelled() {
                return Err(crate::preparation_cancelled("summary indexing cancelled"));
            }
            match &recipe {
                MessageRecipe::System { .. } => {
                    let descriptor = measure_source::describe(
                        recipe,
                        self.fit.budget,
                        self.fit.owner.clone(),
                        self.fit.cancel,
                    )
                    .await?;
                    let mut record = [0; SYSTEM_BYTES as usize];
                    record[..8].copy_from_slice(&(message as u64).to_le_bytes());
                    record[8..].copy_from_slice(&descriptor.commitment);
                    write(
                        self.arena,
                        offset(self.tables.systems.start, self.systems, SYSTEM_BYTES)?,
                        record,
                    )
                    .await?;
                    self.system_breakdown.accumulate(&descriptor.breakdown);
                    self.hash.update(descriptor.commitment);
                    self.systems = self.systems.checked_add(1).ok_or_else(overflow)?;
                    write::<32>(
                        self.arena,
                        offset(self.tables.prefixes.start, self.systems, HASH_BYTES)?,
                        self.hash.clone().finalize().into(),
                    )
                    .await?;
                }
                MessageRecipe::User { content, .. } => self.content(content, message, 0, 0).await?,
                MessageRecipe::Assistant { content, .. } => {
                    let mut parts = content.open(0);
                    let mut outer = 0;
                    while let Some(part) = parts.next().await? {
                        if let AssistantRecipe::ToolResult(ToolResultRecipe {
                            output: ToolOutputRecipe::Content(content),
                            ..
                        }) = part
                        {
                            self.content(&content, message, outer, 1).await?;
                        }
                        outer = outer.checked_add(1).ok_or_else(overflow)?;
                    }
                }
                MessageRecipe::Tool { content, .. } => {
                    let mut results = content.open(0);
                    let mut outer = 0;
                    while let Some(result) = results.next().await? {
                        if let ToolOutputRecipe::Content(content) = result.output {
                            self.content(&content, message, outer, 2).await?;
                        }
                        outer = outer.checked_add(1).ok_or_else(overflow)?;
                    }
                }
            }
            message = message.checked_add(1).ok_or_else(overflow)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Utf8Range {
    prefix: usize,
    body: Range<u64>,
    suffix: bool,
    length: u64,
}
impl Utf8Range {
    async fn repair(arena: &OwnedArena, range: Range<u64>) -> io::Result<Self> {
        let range = arena
            .with_writer(move |writer| {
                let mut first = [0; 3];
                let count =
                    usize::try_from((range.end - range.start).min(3)).map_err(io::Error::other)?;
                writer.read_exact_at(range.start, &mut first[..count])?;
                let prefix = first[..count]
                    .iter()
                    .take_while(|byte| (**byte & 0xc0) == 0x80)
                    .count();
                let start = range.start + prefix as u64;
                let mut end = range.end;
                let mut suffix = false;
                if start < end {
                    let tail_start = start.max(end.saturating_sub(4));
                    let count = usize::try_from(end - tail_start).map_err(io::Error::other)?;
                    let mut tail = [0; 4];
                    writer.read_exact_at(tail_start, &mut tail[..count])?;
                    if let Some(index) = (0..count).rfind(|index| (tail[*index] & 0xc0) != 0x80) {
                        let width = match tail[index] {
                            0..=0x7f => 1,
                            0xc2..=0xdf => 2,
                            0xe0..=0xef => 3,
                            0xf0..=0xf4 => 4,
                            _ => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    "logical summary JSON is not UTF-8",
                                ));
                            }
                        };
                        if count - index < width {
                            end = tail_start + index as u64;
                            suffix = true;
                        }
                    }
                }
                let length = (prefix as u64)
                    .checked_mul(3)
                    .and_then(|bytes| bytes.checked_add(end - start))
                    .and_then(|bytes| bytes.checked_add(u64::from(suffix) * 3))
                    .ok_or_else(overflow)?;
                Ok(Self {
                    prefix,
                    body: start..end,
                    suffix,
                    length,
                })
            })
            .await?;
        Ok(range)
    }
    async fn boundary(&self, arena: &OwnedArena, position: u64, ceil: bool) -> io::Result<u64> {
        let prefix = self.prefix as u64 * 3;
        let body = self.body.end - self.body.start;
        if position <= prefix {
            return Ok(if ceil {
                position.div_ceil(3) * 3
            } else {
                position / 3 * 3
            });
        }
        if position >= prefix + body {
            let value = position - prefix - body;
            return Ok(prefix
                + body
                + if ceil {
                    value.div_ceil(3) * 3
                } else {
                    value / 3 * 3
                });
        }
        let start = self.body.start;
        let end = self.body.end;
        let mut absolute = start + position - prefix;
        absolute = arena
            .with_writer(move |writer| {
                let mut byte = [0];
                while absolute < end {
                    writer.read_exact_at(absolute, &mut byte)?;
                    if byte[0] & 0xc0 != 0x80 {
                        break;
                    }
                    if ceil {
                        absolute += 1;
                    } else {
                        absolute = absolute.checked_sub(1).ok_or_else(overflow)?;
                    }
                }
                Ok(absolute)
            })
            .await?;
        Ok(prefix + absolute - start)
    }
    fn pieces(
        &self,
        arena: &OwnedArena,
        start: u64,
        end: u64,
        output: &mut Vec<TextSource>,
    ) -> io::Result<()> {
        if start == end {
            return Ok(());
        }
        let prefix = self.prefix as u64 * 3;
        let body = self.body.end - self.body.start;
        if start < prefix {
            let end = end.min(prefix);
            let text = "\u{fffd}\u{fffd}\u{fffd}"
                .get(start as usize..end as usize)
                .ok_or_else(overflow)?;
            output.push(literal(text));
        }
        let body_start = start.max(prefix).min(prefix + body);
        let body_end = end.max(prefix).min(prefix + body);
        if body_start < body_end {
            output.push(TextSource::new(
                arena.pending(
                    self.body.start + body_start - prefix..self.body.start + body_end - prefix,
                ),
                TextEncoding::Utf8,
            ));
        }
        if end > prefix + body && self.suffix {
            output.push(literal("\u{fffd}"));
        }
        Ok(())
    }
    async fn excerpt(
        &self,
        arena: &OwnedArena,
        budget: u64,
        language: Language,
        output: &mut Vec<TextSource>,
    ) -> io::Result<()> {
        if self.length <= budget {
            return self.pieces(arena, 0, self.length, output);
        }
        let gap = gap(language);
        if budget < gap.len() as u64 {
            return Ok(());
        }
        let remaining = budget - gap.len() as u64;
        let first = self.boundary(arena, remaining / 2, false).await?;
        let last = self
            .boundary(arena, self.length - (remaining - remaining / 2), true)
            .await?;
        self.pieces(arena, 0, first, output)?;
        output.push(literal(gap));
        self.pieces(arena, last, self.length, output)
    }
}

struct View {
    source: Arc<dyn MessageSource>,
    arena: OwnedArena,
    tables: Tables,
    excerpt: TextSource,
    selected: usize,
    _owner: Arc<Owner>,
}
impl View {
    async fn original_media(&self, record: MediaRecord) -> io::Result<ContentRecipe> {
        let mut messages = self
            .source
            .open(usize::try_from(record.message).map_err(io::Error::other)?);
        let message = messages.next().await?.ok_or_else(overflow)?;
        let content = match (record.kind, message) {
            (0, MessageRecipe::User { content, .. }) => content,
            (1, MessageRecipe::Assistant { content, .. }) => {
                let mut parts =
                    content.open(usize::try_from(record.outer).map_err(io::Error::other)?);
                let Some(AssistantRecipe::ToolResult(ToolResultRecipe {
                    output: ToolOutputRecipe::Content(content),
                    ..
                })) = parts.next().await?
                else {
                    return Err(io::Error::other(
                        "frozen summary assistant media locator changed",
                    ));
                };
                content
            }
            (2, MessageRecipe::Tool { content, .. }) => {
                let mut results =
                    content.open(usize::try_from(record.outer).map_err(io::Error::other)?);
                let Some(ToolResultRecipe {
                    output: ToolOutputRecipe::Content(content),
                    ..
                }) = results.next().await?
                else {
                    return Err(io::Error::other(
                        "frozen summary tool media locator changed",
                    ));
                };
                content
            }
            _ => {
                return Err(io::Error::other(
                    "frozen summary message media locator changed",
                ));
            }
        };
        let mut cursor = content.open(usize::try_from(record.content).map_err(io::Error::other)?);
        match cursor.next().await? {
            Some(part @ ContentRecipe::Media { .. }) => Ok(part),
            _ => Err(io::Error::other(
                "frozen summary content media locator changed",
            )),
        }
    }
}
struct Contents {
    view: Arc<View>,
    length: usize,
}
struct ContentCursor {
    view: Arc<View>,
    position: usize,
    length: usize,
}
impl RecipeSource<ContentRecipe> for Contents {
    fn len(&self) -> usize {
        self.length
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<ContentRecipe>> {
        Box::new(ContentCursor {
            view: self.view.clone(),
            position: start,
            length: self.length,
        })
    }
}
impl RecipeCursor<ContentRecipe> for ContentCursor {
    fn next(&mut self) -> NextRecipe<'_, ContentRecipe> {
        Box::pin(async move {
            if self.position >= self.length {
                return Ok(None);
            }
            let position = self.position;
            self.position += 1;
            if position == 0 {
                return Ok(Some(ContentRecipe::Text {
                    text: self.view.excerpt.clone(),
                    provider_options: None,
                }));
            }
            let index = self.view.selected + (position - 1) / 2;
            let record = media_record(&self.view.arena, &self.view.tables, index).await?;
            if position % 2 == 1 {
                let end = record
                    .label_start
                    .checked_add(record.label_bytes)
                    .ok_or_else(overflow)?;
                Ok(Some(ContentRecipe::Text {
                    text: TextSource::new(
                        self.view.arena.pending(record.label_start..end),
                        TextEncoding::Utf8,
                    ),
                    provider_options: None,
                }))
            } else {
                self.view.original_media(record).await.map(Some)
            }
        })
    }
}
struct Directory {
    view: Arc<View>,
    systems: usize,
    user: MessageRecipe,
    user_metadata: MessageMetadata,
    final_prefix: [u8; 32],
}
struct Messages(Arc<Directory>);
struct MessageCursor {
    directory: Arc<Directory>,
    position: usize,
}
struct MetadataCursor {
    directory: Arc<Directory>,
    position: usize,
}
impl RecipeSource<MessageRecipe> for Messages {
    fn len(&self) -> usize {
        self.0.systems + 1
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(MessageCursor {
            directory: self.0.clone(),
            position: start,
        })
    }
}
impl RecipeCursor<MessageRecipe> for MessageCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
        Box::pin(async move {
            if self.position > self.directory.systems {
                return Ok(None);
            }
            let position = self.position;
            self.position += 1;
            if position == self.directory.systems {
                return Ok(Some(self.directory.user.clone()));
            }
            let record: [u8; SYSTEM_BYTES as usize] = read(
                &self.directory.view.arena,
                offset(
                    self.directory.view.tables.systems.start,
                    position,
                    SYSTEM_BYTES,
                )?,
            )
            .await?;
            let index = usize::try_from(u64::from_le_bytes(
                record[..8].try_into().expect("system index word"),
            ))
            .map_err(io::Error::other)?;
            let mut cursor = self.directory.view.source.open(index);
            match cursor.next().await? {
                Some(message @ MessageRecipe::System { .. }) => Ok(Some(message)),
                _ => Err(io::Error::other("frozen summary system locator changed")),
            }
        })
    }
}
impl MessageSource for Messages {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(MetadataCursor {
            directory: self.0.clone(),
            position: start,
        })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            if messages > self.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "summary prefix exceeds directory",
                ));
            }
            if messages == self.len() {
                return Ok(hex::encode(self.0.final_prefix));
            }
            let hash: [u8; 32] = read(
                &self.0.view.arena,
                offset(self.0.view.tables.prefixes.start, messages, HASH_BYTES)?,
            )
            .await?;
            Ok(hex::encode(hash))
        })
    }
}
impl RecipeCursor<MessageMetadata> for MetadataCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            if self.position > self.directory.systems {
                return Ok(None);
            }
            let position = self.position;
            self.position += 1;
            if position == self.directory.systems {
                return Ok(Some(self.directory.user_metadata.clone()));
            }
            let record: [u8; SYSTEM_BYTES as usize] = read(
                &self.directory.view.arena,
                offset(
                    self.directory.view.tables.systems.start,
                    position,
                    SYSTEM_BYTES,
                )?,
            )
            .await?;
            Ok(Some(MessageMetadata {
                message_index: position,
                logical_identity: hex::encode(&record[8..]).into(),
                role: MessageRole::System,
                last_is_tool_result: false,
                local_tool_names: self.directory.user_metadata.local_tool_names.clone(),
                settled_tool_call_ids: self.directory.user_metadata.settled_tool_call_ids.clone(),
            }))
        })
    }
}

async fn omitted_range(
    arena: &OwnedArena,
    tables: &Tables,
    omitted: usize,
    budget: u64,
) -> io::Result<Option<Range<u64>>> {
    if omitted == 0 {
        return Ok(None);
    }
    let last = media_record(arena, tables, omitted - 1).await?;
    let mut start = 0usize;
    let mut end = omitted;
    while start < end {
        let mid = start + (end - start) / 2;
        let before = if mid == 0 {
            0
        } else {
            media_record(arena, tables, mid - 1).await?.label_prefix
        };
        if last.label_prefix - before > budget {
            start = mid + 1;
        } else {
            end = mid;
        }
    }
    if start == omitted {
        return Ok(None);
    }
    let first = media_record(arena, tables, start).await?;
    Ok(Some(
        first.label_start
            ..last
                .label_start
                .checked_add(last.label_bytes)
                .ok_or_else(overflow)?,
    ))
}
async fn retained_tokens(
    arena: &OwnedArena,
    tables: &Tables,
    total: usize,
    selected: usize,
) -> io::Result<u64> {
    if total == selected {
        return Ok(0);
    }
    let total = media_record(arena, tables, total - 1).await?.token_prefix;
    let before = if selected == 0 {
        0
    } else {
        media_record(arena, tables, selected - 1)
            .await?
            .token_prefix
    };
    total.checked_sub(before).ok_or_else(overflow)
}
fn pieces_bytes(pieces: &[TextSource]) -> io::Result<u64> {
    pieces.iter().try_fold(0u64, |total, piece| {
        let bytes = match piece.bytes() {
            SourceBytes::Inline(bytes) => bytes.len() as u64,
            SourceBytes::Source(source) => source.len().ok_or_else(overflow)?,
        };
        total.checked_add(bytes).ok_or_else(overflow)
    })
}
fn omission_parts(language: Language) -> (&'static str, &'static str) {
    match language {
        Language::En => (
            "\n[",
            " media parts omitted; original media remains in locally stored history.]\n",
        ),
        Language::ZhCn => ("\n[省略了 ", " 个媒体部分；原件仍保存在本地历史中。]\n"),
        Language::ZhTw => ("\n[省略了 ", " 個媒體部分；原件仍儲存在本機歷史中。]\n"),
    }
}
fn omission_capacity(language: Language) -> usize {
    let (start, end) = omission_parts(language);
    start.len() + end.len() + usize::MAX.ilog10() as usize + 1
}
fn omission(omitted: usize, language: Language) -> String {
    let (start, end) = omission_parts(language);
    let mut output = String::with_capacity(omission_capacity(language));
    write!(&mut output, "{start}{omitted}{end}").expect("reserved omission accepts formatting");
    output
}

pub(super) fn allocation_bytes(language: Language) -> io::Result<usize> {
    let (start, middle, end) = prefix_parts(language);
    let digits = usize::MAX.ilog10() as usize + 1;
    let prefix = start.len() + middle.len() + end.len() + 2 * digits;
    let mut bytes =
        arc::<Owner>() + arc::<View>() + arc::<Contents>() + arc::<Directory>() + arc::<Messages>();
    add(&mut bytes, array::<TextSource>(TEXT_PIECES)?)?;
    add(&mut bytes, items::<TextSource>(TEXT_PIECES)?)?;
    add(&mut bytes, text::concat_metadata_bytes()?)?;
    add(
        &mut bytes,
        RANGE_SOURCES * arc::<OwnedSource>()
            + std::mem::size_of::<OwnedCursor>()
            + 2 * std::mem::size_of::<Arc<dyn Send + Sync>>(),
    )?;
    add(
        &mut bytes,
        crate::history::capture_arena::source_metadata_bytes(RANGE_SOURCES)?,
    )?;
    let temporary_label = 2 * prefix
        + arc::<Allocation>()
        + arc::<Resident>()
        + array::<TextSource>(3)?
        + items::<TextSource>(3)?
        + text::concat_metadata_bytes()?;
    add(&mut bytes, 2 * temporary_label)?;
    add(
        &mut bytes,
        2 * items::<IdentifiedText>(0)? + 2 * std::mem::size_of::<usize>() + 64,
    )?;
    add(
        &mut bytes,
        std::mem::size_of::<MessageDescriptor>()
            + std::mem::size_of::<Index<'_>>()
            + std::mem::size_of::<ArenaEmit>()
            + std::mem::size_of::<ContentCursor>()
            + std::mem::size_of::<MessageCursor>()
            + std::mem::size_of::<MetadataCursor>()
            + 3 * std::mem::size_of::<Utf8Range>()
            + std::mem::size_of::<Sha256>(),
    )?;
    // At most one count notice is live; each integer has at most `digits` bytes.
    add(
        &mut bytes,
        2 * (omission_capacity(language) + arc::<Allocation>() + arc::<Resident>()),
    )?;
    Ok(bytes)
}

pub(super) async fn fit(
    prompt: &PreparedPrompt,
    tokens: u64,
    language: Language,
    cancel: &CancellationToken,
    active: &ActivePreparation,
) -> Result<PreparedPrompt, FitError> {
    let resources = prompt.resources().ok_or_else(|| {
        failure(io::Error::other(
            "backed summary lacks Host preparation resources",
        ))
    })?;
    let arena = prompt
        .arena()
        .ok_or_else(|| {
            failure(io::Error::other(
                "backed summary lacks its original request arena",
            ))
        })?
        .clone();
    let source = prompt.recipes().ok_or_else(|| {
        failure(io::Error::other(
            "backed summary lacks immutable message recipes",
        ))
    })?;
    let model = prompt.model();
    let mut systems = 0usize;
    let mut metadata = source.open_metadata(0);
    while let Some(message) = metadata.next().await.map_err(failure)? {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        if message.role == MessageRole::System {
            systems = systems.checked_add(1).ok_or_else(|| failure(overflow()))?;
        }
    }
    drop(metadata);
    let media = usize::try_from(prompt.breakdown().counts.media)
        .map_err(|error| failure(io::Error::other(error)))?;
    let bytes = allocation_bytes(language).map_err(failure)?;
    let lease = active.directory(bytes).map_err(failure)?;
    let required = prompt
        .resident_bytes()
        .checked_add(prompt.overlay_bytes())
        .and_then(|input| input.checked_add(bytes))
        .ok_or_else(|| failure(overflow()))?;
    let owner = Arc::new(Owner {
        _input: prompt.without_wire(),
        _lease: lease,
    });
    let work = tokio::select! {biased;_=cancel.cancelled()=>return Err(RunError::Cancelled.into()),work=resources.acquire_work()=>work.map_err(failure)?};
    let budget = work.budget();
    let arena = OwnedArena {
        arena,
        owner: owner.clone(),
    };
    arena.arena.promote_to_file().await.map_err(failure)?;
    let (start, middle, end) = prefix_parts(language);
    let prefix_capacity =
        start.len() + middle.len() + end.len() + 2 * (usize::MAX.ilog10() as usize + 1);
    let fit = Fit {
        language,
        prefix_capacity,
        owner: &owner,
        budget: &budget,
        cancel,
    };
    let media_region = reserve(
        &arena,
        u64::try_from(media)
            .map_err(|error| failure(io::Error::other(error)))?
            .checked_mul(MEDIA_BYTES)
            .ok_or_else(|| failure(overflow()))?,
        &fit,
    )
    .await
    .map_err(failure)?;
    let system_region = reserve(
        &arena,
        u64::try_from(systems)
            .map_err(|error| failure(io::Error::other(error)))?
            .checked_mul(SYSTEM_BYTES)
            .ok_or_else(|| failure(overflow()))?,
        &fit,
    )
    .await
    .map_err(failure)?;
    let prefix_region = reserve(
        &arena,
        u64::try_from(systems)
            .map_err(|error| failure(io::Error::other(error)))?
            .checked_add(1)
            .and_then(|count| count.checked_mul(HASH_BYTES))
            .ok_or_else(|| failure(overflow()))?,
        &fit,
    )
    .await
    .map_err(failure)?;
    let tables = Tables {
        media: media_region,
        systems: system_region,
        prefixes: prefix_region,
    };
    let mut hash = Sha256::new();
    hash.update(b"maka.logical-prefix\0");
    let mut index = Index {
        source: &source,
        arena: &arena,
        tables: tables.clone(),
        fit: &fit,
        media: 0,
        systems: 0,
        label_prefix: 0,
        token_prefix: 0,
        system_breakdown: Default::default(),
        hash,
    };
    index.build().await.map_err(failure)?;
    if index.media != media || index.systems != systems {
        return Err(failure(io::Error::other(
            "summary metadata changed after planning",
        )));
    }
    arena.arena.seal().await.map_err(failure)?;
    let mut sink = ArenaEmit::new_owned(arena.arena.clone(), &budget, cancel, owner.clone())
        .await
        .map_err(failure)?;
    let logical_start = sink.position();
    let mut recent_start = logical_start;
    let mut cursor = source.open(0);
    let mut position = 0usize;
    while let Some(message) = cursor.next().await.map_err(failure)? {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        if !matches!(message, MessageRecipe::System { .. }) {
            if matches!(message, MessageRecipe::User { .. }) {
                recent_start = sink.position();
            }
            let mut replace = |part, content: &ContentRecipe| fit.label(position, part, content);
            serialize_source::message_async(&message, &budget, cancel, &mut sink, &mut replace)
                .await
                .map_err(failure)?;
            sink.write(b"\n").await.map_err(failure)?;
        }
        position = position.checked_add(1).ok_or_else(|| failure(overflow()))?;
    }
    drop(cursor);
    let logical_end = sink.position();
    sink.finish().await.map_err(failure)?;
    arena.arena.seal().await.map_err(failure)?;
    let max_bytes = tokens.saturating_mul(3);
    let limit = max_bytes / 2;
    let head = Utf8Range::repair(
        &arena,
        logical_start..logical_end.min(logical_start.saturating_add(limit)),
    )
    .await
    .map_err(failure)?;
    let recent = Utf8Range::repair(
        &arena,
        recent_start..logical_end.min(recent_start.saturating_add(limit / 2)),
    )
    .await
    .map_err(failure)?;
    let tail = Utf8Range::repair(
        &arena,
        logical_start.max(logical_end.saturating_sub(limit))..logical_end,
    )
    .await
    .map_err(failure)?;
    let max_files = usize::try_from(tokens.saturating_mul(3) / 4 / 1024)
        .unwrap_or(usize::MAX)
        .min(media);
    let mut selected = media - max_files;
    let system_tokens = index.system_breakdown.estimated_tokens();
    let mut text_bytes = max_bytes.saturating_sub(system_tokens.saturating_mul(3));
    loop {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        let omitted = selected;
        let mut pieces = Vec::with_capacity(TEXT_PIECES);
        pieces.push(literal(notice(language)));
        if omitted != 0 {
            pieces.push(resident(omission(omitted, language), &owner));
            if let Some(range) = omitted_range(&arena, &tables, omitted, max_bytes / 4)
                .await
                .map_err(failure)?
            {
                let labels = Utf8Range {
                    prefix: 0,
                    length: range.end - range.start,
                    body: range,
                    suffix: false,
                };
                labels
                    .excerpt(&arena, max_bytes / 8, language, &mut pieces)
                    .await
                    .map_err(failure)?;
            }
        }
        let (earlier, recent_label) = headings(language);
        pieces.push(literal("\n"));
        pieces.push(literal(earlier));
        pieces.push(literal("\n"));
        head.excerpt(&arena, text_bytes / 3, language, &mut pieces)
            .await
            .map_err(failure)?;
        pieces.push(literal("\n"));
        pieces.push(literal(recent_label));
        pieces.push(literal("\n"));
        recent
            .excerpt(&arena, text_bytes / 3, language, &mut pieces)
            .await
            .map_err(failure)?;
        pieces.push(literal("\n"));
        tail.excerpt(&arena, text_bytes / 3, language, &mut pieces)
            .await
            .map_err(failure)?;
        let text_length = pieces_bytes(&pieces).map_err(failure)?;
        let used = system_tokens
            .saturating_add(16)
            .saturating_add(text_length.div_ceil(3))
            .saturating_add(
                retained_tokens(&arena, &tables, media, selected)
                    .await
                    .map_err(failure)?,
            );
        if used <= tokens || (text_bytes == 0 && selected == media) {
            let excerpt = text::concat(Arc::new(Items::new(pieces, owner.clone())), budget.clone());
            let files = media - selected;
            let length = files
                .checked_mul(2)
                .and_then(|count| count.checked_add(1))
                .ok_or_else(|| failure(overflow()))?;
            let view = Arc::new(View {
                source: source.clone(),
                arena: arena.clone(),
                tables: tables.clone(),
                excerpt,
                selected,
                _owner: owner.clone(),
            });
            let user = MessageRecipe::User {
                content: Arc::new(Contents {
                    view: view.clone(),
                    length,
                }),
                provider_options: None,
            };
            let descriptor = measure_source::describe(user.clone(), &budget, owner.clone(), cancel)
                .await
                .map_err(failure)?;
            let user_metadata = MessageMetadata {
                message_index: systems,
                logical_identity: descriptor.logical_identity.clone(),
                role: MessageRole::User,
                last_is_tool_result: false,
                local_tool_names: descriptor.local_tool_names.clone(),
                settled_tool_call_ids: descriptor.settled_tool_call_ids.clone(),
            };
            let mut breakdown = index.system_breakdown.clone();
            breakdown.accumulate(&descriptor.breakdown);
            let mut hash = index.hash.clone();
            hash.update(descriptor.commitment);
            let final_prefix: [u8; 32] = hash.finalize().into();
            let directory = Arc::new(Directory {
                view,
                systems,
                user,
                user_metadata,
                final_prefix,
            });
            let mut body = Prompt::from_recipes(
                Arc::new(Messages(directory)),
                hex::encode(final_prefix),
                systems + 1,
                breakdown,
            )
            .with_instructions_from(&model);
            if let Some(provider) = model.normalization() {
                body = body.with_normalization(provider.clone());
            }
            let fitted = PreparedPrompt::new(body)
                .with_resources(resources.clone())
                .with_preparation_from(prompt)
                .with_resident_bytes(required)
                .with_arena(arena.arena);
            return Ok(fitted);
        }
        if text_bytes > 0 {
            text_bytes = text_bytes
                .saturating_sub((used - tokens).saturating_mul(3))
                .min(text_bytes / 2);
        } else {
            selected = selected.checked_add(1).ok_or_else(|| failure(overflow()))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;

    #[tokio::test]
    async fn cancelled_backed_metadata_observer_keeps_full_until_worker_completion() {
        let (_directory, root, execution, captured) =
            super::super::tests::captured_summary_source().await;
        let arena = CaptureArena::new(captured, None).await.unwrap();
        let record = arena
            .with_writer(|writer| writer.append_bytes(&17_u64.to_le_bytes()))
            .await
            .unwrap();
        arena.seal().await.unwrap();
        let (prompt, _, _) = super::super::tests::fixture();
        let bytes = allocation_bytes(Language::En).unwrap();
        let full = bytes + prompt.overlay_bytes() + PreparedPrompt::backed_wire_bytes();
        let resources = maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
            resident_bytes: full,
            ..Default::default()
        })
        .unwrap();
        let prompt = prompt
            .with_resources(resources.clone())
            .with_arena(arena.clone());
        let active = resources
            .reserve_staging(0)
            .await
            .unwrap()
            .promote(full)
            .await
            .unwrap();
        let owned = OwnedArena {
            arena: arena.clone(),
            owner: Arc::new(Owner {
                _input: prompt.without_wire(),
                _lease: active.directory(bytes).unwrap(),
            }),
        };
        let (entered, in_worker) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let (finished, completed) = tokio::sync::oneshot::channel();
        let mut observer = Box::pin(owned.with_writer(move |writer| {
            let mut bytes = [0; 8];
            writer.read_exact_at(record.start, &mut bytes)?;
            let _ = entered.send(u64::from_le_bytes(bytes));
            released.blocking_recv().map_err(io::Error::other)?;
            let _ = finished.send(());
            Ok(())
        }));
        let value = tokio::select! {
            result = &mut observer => panic!("metadata observer finished before callback release: {result:?}"),
            result = tokio::time::timeout(std::time::Duration::from_secs(2), in_worker) => {
                result.expect("metadata callback must execute on the original worker").unwrap()
            }
        };
        assert_eq!(value, 17);
        let mut competing = Box::pin(resources.reserve_staging(0).await.unwrap().promote(full));
        drop(observer);
        drop((owned, prompt, active));
        assert!(
            poll!(competing.as_mut()).is_pending(),
            "accepted metadata callback must retain Full after observer cancellation"
        );
        release.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), completed)
            .await
            .expect("accepted metadata callback must finish")
            .unwrap();
        drop(
            tokio::time::timeout(std::time::Duration::from_secs(2), competing)
                .await
                .expect("Full must advance after the accepted metadata callback")
                .unwrap(),
        );
        arena.close().await.unwrap();
        drop(arena);
        execution.finish();
        root.shutdown().await.unwrap();
    }
}
