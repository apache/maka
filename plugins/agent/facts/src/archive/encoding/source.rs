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

use super::{MEDIA_MIME_PREFIX, MEDIA_PREFIX, MEDIA_SUFFIX, key_prefix_order, key_units, number};
use crate::{
    model::prompt_source::source::{
        ByteCursor, ByteSource, ChargedBuffer, JsonSource, NextRecipe, ReadSource, RecipeCursor,
        RecipeSource, SourceBudget, SourceBytes, SourceRead, TextEncoding, TextSource,
        json::{self, ArrayCursor, JsonKind, JsonValue, ObjectCursor, number::NumberValidator},
        text,
    },
    tool_output::DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE,
};
use bytes::Bytes;
use std::{io, mem::size_of, ops::Range, sync::Arc};

/// Archive body bytes, not the original projection JSON or decoded text bytes.
/// The supplied source retains its original custody; this adapter has no locator.
pub fn projection_source(projection: JsonSource) -> Arc<dyn ByteSource> {
    encoded(projection, Mode::Projection)
}

/// The strict, key-sorted JSON bytes hashed by `projection_digest`.
/// This stream is separate from the archive body hashed by `body_sha256`.
pub fn projection_identity_source(projection: JsonSource) -> Arc<dyn ByteSource> {
    encoded(projection, Mode::Json(true))
}

#[derive(Clone, Copy)]
enum Mode {
    Projection,
    Json(bool),
    Parts,
    Part,
}
struct Encoded {
    source: JsonSource,
    mode: Mode,
}
fn encoded(source: JsonSource, mode: Mode) -> Arc<dyn ByteSource> {
    Arc::new(Encoded { source, mode })
}
fn child(source: JsonSource, mode: Mode) -> SourceBytes {
    SourceBytes::Source(encoded(source, mode))
}
fn literal(bytes: &'static [u8]) -> SourceBytes {
    SourceBytes::Inline(Bytes::from_static(bytes))
}
fn inline_text(value: &'static str) -> TextSource {
    TextSource::new(literal(value.as_bytes()), TextEncoding::Utf8)
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
impl ByteSource for Encoded {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            plan: Plan::Init(self.source.clone(), self.mode),
            active: None,
            budget,
            metadata: None,
            owner: Arc::new(self.source.clone()),
            failed: false,
        })
    }
}

enum Plan {
    Init(JsonSource, Mode),
    Sequence([Option<SourceBytes>; 5]),
    Array {
        cursor: ArrayCursor,
        mode: Mode,
        first: bool,
        nonempty: bool,
    },
    Object {
        fields: Directory,
        at: usize,
        stable: bool,
    },
    Done,
}
fn sequence<const N: usize>(parts: [SourceBytes; N]) -> Plan {
    assert!(N <= 5, "archive sequence exceeds its fixed slots");
    let mut slots = std::array::from_fn(|_| None);
    for (slot, part) in slots.iter_mut().zip(parts) {
        *slot = Some(part);
    }
    Plan::Sequence(slots)
}
struct Cursor {
    plan: Plan,
    active: Option<Box<dyn ByteCursor>>,
    budget: Arc<dyn SourceBudget>,
    metadata: Option<ChargedBuffer>,
    owner: Arc<dyn Send + Sync>,
    failed: bool,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            if self.failed {
                return Err(invalid("archive cursor previously failed"));
            }
            let result = self.read(buffer).await;
            self.failed |= result.is_err();
            result
        })
    }
}
impl Cursor {
    async fn read(&mut self, mut buffer: ChargedBuffer) -> io::Result<SourceRead> {
        if buffer.as_ref().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "empty archive work buffer",
            ));
        }
        if self.metadata.is_none() {
            // Reserve cursor/control metadata as well as the separately charged
            // key directory. No opaque value length contributes to this charge.
            self.metadata = Some(self.budget.allocate(size_of::<Self>() * 2).await?);
        }
        loop {
            if let Some(active) = &mut self.active {
                let read = active.read_chunk(buffer).await?;
                if read.bytes_read > read.buffer.as_ref().len()
                    || (read.bytes_read == 0 && !read.eof)
                {
                    return Err(invalid("invalid archive child read"));
                }
                if read.eof {
                    self.active = None;
                }
                if read.bytes_read != 0 {
                    return Ok(SourceRead {
                        buffer: read.buffer.retain_owner(self.owner.clone()),
                        bytes_read: read.bytes_read,
                        eof: false,
                    });
                }
                buffer = read.buffer;
                continue;
            }
            let next = match &mut self.plan {
                Plan::Init(source, mode) => {
                    let plan = initialize(source.clone(), *mode, self.budget.clone()).await?;
                    self.plan = plan;
                    continue;
                }
                Plan::Sequence(parts) => {
                    if let Some(part) = parts.iter_mut().find_map(Option::take) {
                        Some(part)
                    } else {
                        self.plan = Plan::Done;
                        None
                    }
                }
                Plan::Array {
                    cursor,
                    mode,
                    first,
                    nonempty,
                } => match cursor.next().await? {
                    Some(value) => {
                        let prefix = if *first { b"[" as &'static [u8] } else { b"," };
                        *first = false;
                        Some(joined([literal(prefix), child(value.source, *mode)]))
                    }
                    None => {
                        if *nonempty && *first {
                            return Err(invalid("invalid archive content"));
                        }
                        let end = if *first { b"[]" as &'static [u8] } else { b"]" };
                        self.plan = Plan::Done;
                        Some(literal(end))
                    }
                },
                Plan::Object { fields, at, stable } => {
                    if *at == fields.len() {
                        let end = if *at == 0 {
                            b"{}" as &'static [u8]
                        } else {
                            b"}"
                        };
                        self.plan = Plan::Done;
                        Some(literal(end))
                    } else {
                        let (key, value) = fields.field(*at)?;
                        let prefix = if *at == 0 {
                            b"{" as &'static [u8]
                        } else {
                            b","
                        };
                        *at += 1;
                        Some(joined([
                            literal(prefix),
                            text::json_string(key, self.budget.clone()).into_bytes(),
                            literal(b":"),
                            child(value, Mode::Json(*stable)),
                        ]))
                    }
                }
                Plan::Done => {
                    return Ok(SourceRead {
                        buffer: buffer.retain_owner(self.owner.clone()),
                        bytes_read: 0,
                        eof: true,
                    });
                }
            };
            if let Some(next) = next {
                self.active = Some(next.open(self.budget.clone()));
            }
        }
    }
}

struct Joined([Option<SourceBytes>; 5]);
fn joined<const N: usize>(parts: [SourceBytes; N]) -> SourceBytes {
    let Plan::Sequence(parts) = sequence(parts) else {
        unreachable!()
    };
    SourceBytes::Source(Arc::new(Joined(parts)))
}
impl ByteSource for Joined {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            plan: Plan::Sequence(self.0.clone()),
            active: None,
            budget,
            metadata: None,
            owner: Arc::new(self.0.clone()),
            failed: false,
        })
    }
}

fn initialize(
    source: JsonSource,
    mode: Mode,
    budget: Arc<dyn SourceBudget>,
) -> impl std::future::Future<Output = io::Result<Plan>> + Send {
    // Child cursors recurse; construct the initializer outside each cursor's poll frame.
    Box::pin(initialize_inner(source, mode, budget))
}

async fn initialize_inner(
    source: JsonSource,
    mode: Mode,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Plan> {
    match mode {
        Mode::Projection => {
            let [kind, text_value, value, parts] =
                schema(&source, ["kind", "text", "value", "parts"], budget.clone()).await?;
            let kind = required(kind)?.text()?;
            if json::text_eq(&kind, "text", budget.clone()).await?
                && value.is_none()
                && parts.is_none()
            {
                Ok(sequence([text::json_string(
                    required(text_value)?.text()?,
                    budget,
                )
                .into_bytes()]))
            } else if json::text_eq(&kind, "json", budget.clone()).await?
                && text_value.is_none()
                && parts.is_none()
            {
                Ok(Plan::Init(required(value)?.source, Mode::Json(false)))
            } else if json::text_eq(&kind, "content", budget.clone()).await?
                && text_value.is_none()
                && value.is_none()
            {
                Ok(Plan::Init(required(parts)?.source, Mode::Parts))
            } else if json::text_eq(&kind, "failure", budget.clone()).await?
                && text_value.is_none()
                && value.is_none()
                && parts.is_none()
            {
                Ok(sequence([text::json_string(
                    inline_text(DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE),
                    budget,
                )
                .into_bytes()]))
            } else {
                Err(invalid("invalid durable projection"))
            }
        }
        Mode::Parts => Ok(Plan::Array {
            cursor: ArrayCursor::open(source, budget).await?,
            mode: Mode::Part,
            first: true,
            nonempty: true,
        }),
        Mode::Part => {
            let part = part_text(source, budget.clone()).await?;
            Ok(sequence([
                literal(b"{\"type\":\"text\",\"text\":"),
                text::json_string(part, budget).into_bytes(),
                literal(b"}"),
            ]))
        }
        Mode::Json(stable) => match json::kind(&source, budget.clone()).await? {
            JsonKind::Array => Ok(Plan::Array {
                cursor: ArrayCursor::open(source, budget).await?,
                mode: Mode::Json(stable),
                first: true,
                nonempty: false,
            }),
            JsonKind::Object => Ok(Plan::Object {
                fields: Directory::open(source, stable, budget).await?,
                at: 0,
                stable,
            }),
            JsonKind::String => Ok(sequence([text::json_string(
                TextSource::new(source.into_bytes(), TextEncoding::JsonString),
                budget,
            )
            .into_bytes()])),
            JsonKind::Number => {
                let mut cursor = source.bytes().open(budget.clone());
                let mut buffer = budget.allocate(1024).await?;
                let mut number_value = NumberValidator::new();
                loop {
                    let read = cursor.read_chunk(buffer).await?;
                    checked_read(&read)?;
                    for byte in &read.buffer.as_ref()[..read.bytes_read] {
                        number_value.push(*byte)?;
                    }
                    buffer = read.buffer;
                    if read.eof {
                        break;
                    }
                }
                let value = number_value.into_representative_value()?;
                let token = number(value.as_number().ok_or_else(|| invalid("invalid number"))?)
                    .map_err(invalid)?;
                Ok(sequence([SourceBytes::Inline(Bytes::from(token))]))
            }
            JsonKind::Bool => Ok(sequence([literal(
                if json::bool_value(&source, budget).await? {
                    b"true"
                } else {
                    b"false"
                },
            )])),
            JsonKind::Null => Ok(sequence([literal(b"null")])),
        },
    }
}
fn checked_read(read: &SourceRead) -> io::Result<()> {
    if read.bytes_read > read.buffer.as_ref().len() || (read.bytes_read == 0 && !read.eof) {
        return Err(invalid("invalid archive source read"));
    }
    Ok(())
}
fn required(value: Option<JsonValue>) -> io::Result<JsonValue> {
    value.ok_or_else(|| invalid("missing projection field"))
}
async fn schema<const N: usize>(
    source: &JsonSource,
    names: [&str; N],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<[Option<JsonValue>; N]> {
    let mut values: [Option<JsonValue>; N] = std::array::from_fn(|_| None);
    let mut cursor = ObjectCursor::open(source.clone(), budget).await?;
    while let Some((field, selected)) = cursor.next_named(names.iter().copied()).await? {
        let selected = selected.ok_or_else(|| invalid("unknown projection field"))?;
        if values[selected].is_some() {
            return Err(invalid("duplicate projection field"));
        }
        values[selected] = Some(field.value);
    }
    Ok(values)
}

async fn part_text(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<TextSource> {
    let [kind, text_value, image, audio] =
        schema(&source, ["kind", "text", "image", "audio"], budget.clone()).await?;
    let kind = required(kind)?.text()?;
    if json::text_eq(&kind, "text", budget.clone()).await? && image.is_none() && audio.is_none() {
        return required(text_value)?.text();
    }
    if text_value.is_some() {
        return Err(invalid("invalid projection part"));
    }
    let media = if json::text_eq(&kind, "artifact", budget.clone()).await? && audio.is_none() {
        let [mime, reference, detail] = schema(
            &required(image)?.source,
            ["mimeType", "ref", "detail"],
            budget.clone(),
        )
        .await?;
        if let Some(detail) = detail {
            if detail.kind != JsonKind::Null {
                let detail = detail.text()?;
                let mut valid = false;
                for name in ["auto", "low", "high", "original"] {
                    valid |= json::text_eq(&detail, name, budget.clone()).await?;
                }
                if !valid {
                    return Err(invalid("invalid image detail"));
                }
            }
        }
        (required(mime)?.text()?, required(reference)?.source)
    } else if json::text_eq(&kind, "audio", budget.clone()).await? && image.is_none() {
        let [mime, reference] = schema(
            &required(audio)?.source,
            ["mimeType", "ref"],
            budget.clone(),
        )
        .await?;
        (required(mime)?.text()?, required(reference)?.source)
    } else {
        return Err(invalid("invalid projection part"));
    };
    let [kind, session, path] = schema(
        &media.1,
        ["kind", "sessionId", "relativePath"],
        budget.clone(),
    )
    .await?;
    if !json::text_eq(&required(kind)?.text()?, "session_file", budget.clone()).await? {
        return Err(invalid("archive media must be Session-owned"));
    }
    required(session)?.text()?;
    let path = text::json_string(required(path)?.text()?, budget.clone());
    Ok(text::concat(
        Arc::new(TextPieces([
            inline_text(MEDIA_PREFIX),
            path,
            inline_text(MEDIA_MIME_PREFIX),
            media.0,
            inline_text(MEDIA_SUFFIX),
        ])),
        budget,
    ))
}
struct TextPieces([TextSource; 5]);
struct TextPiecesCursor {
    parts: [TextSource; 5],
    at: usize,
}
impl RecipeSource<TextSource> for TextPieces {
    fn len(&self) -> usize {
        5
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<TextSource>> {
        Box::new(TextPiecesCursor {
            parts: self.0.clone(),
            at: start,
        })
    }
}
impl RecipeCursor<TextSource> for TextPiecesCursor {
    fn next(&mut self) -> NextRecipe<'_, TextSource> {
        Box::pin(async move {
            let value = self.parts.get(self.at).cloned();
            self.at += usize::from(value.is_some());
            Ok(value)
        })
    }
}

// Fixed records avoid a heap allocation or source handle per field. Keys alone
// are decoded for sorting; opaque values remain ranges under the original owner.
const RECORD: usize = 56;
struct Arena {
    buffer: Option<ChargedBuffer>,
    used: usize,
}
impl Arena {
    fn new() -> Self {
        Self {
            buffer: None,
            used: 0,
        }
    }
    fn bytes(&self) -> &[u8] {
        self.buffer
            .as_ref()
            .map_or(&[], |buffer| &buffer.as_ref()[..self.used])
    }
    async fn append(&mut self, bytes: &[u8], budget: &Arc<dyn SourceBudget>) -> io::Result<()> {
        let needed = self
            .used
            .checked_add(bytes.len())
            .ok_or_else(|| invalid("archive directory overflow"))?;
        if self
            .buffer
            .as_ref()
            .is_none_or(|buffer| buffer.as_ref().len() < needed)
        {
            let previous = self
                .buffer
                .as_ref()
                .map_or(0, |buffer| buffer.as_ref().len());
            let capacity = needed.max(previous.saturating_mul(2)).max(RECORD);
            let mut buffer = budget.allocate(capacity).await?;
            if buffer.as_ref().len() < capacity {
                return Err(invalid("short archive work allocation"));
            }
            buffer.as_mut()[..self.used].copy_from_slice(self.bytes());
            self.buffer = Some(buffer);
        }
        self.buffer.as_mut().expect("reserved directory").as_mut()[self.used..needed]
            .copy_from_slice(bytes);
        self.used = needed;
        Ok(())
    }
}
struct Directory {
    source: JsonSource,
    records: Arena,
    keys: Arena,
}
impl Directory {
    async fn open(
        source: JsonSource,
        stable: bool,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Self> {
        let mut cursor = ObjectCursor::open(source.clone(), budget.clone()).await?;
        let mut directory = Self {
            source,
            records: Arena::new(),
            keys: Arena::new(),
        };
        let mut work = budget.allocate(4096).await?;
        while let Some(spans) = cursor.next_spans().await? {
            let start = directory.keys.used;
            let key = TextSource::new(
                directory.source.bytes().slice(spans.key_range.clone())?,
                TextEncoding::JsonString,
            );
            let mut key_cursor = text::cursor(key, budget.clone());
            loop {
                let read = key_cursor.read_chunk(work).await?;
                checked_read(&read)?;
                directory
                    .keys
                    .append(&read.buffer.as_ref()[..read.bytes_read], &budget)
                    .await?;
                work = read.buffer;
                if read.eof {
                    break;
                }
            }
            let mut record = [0; RECORD];
            for (slot, value) in record.chunks_exact_mut(8).zip([
                start as u64,
                directory.keys.used as u64,
                spans.key_range.start,
                spans.key_range.end,
                spans.value_range.start,
                spans.value_range.end,
                directory.len() as u64,
            ]) {
                slot.copy_from_slice(&value.to_le_bytes());
            }
            directory.records.append(&record, &budget).await?;
        }
        drop(cursor);
        drop(work);
        let keys = directory.keys.bytes();
        if let Some(buffer) = &mut directory.records.buffer {
            let (records, tail) =
                buffer.as_mut()[..directory.records.used].as_chunks_mut::<RECORD>();
            debug_assert!(tail.is_empty());
            sort_fields(records, keys, stable).await;
        }
        Ok(directory)
    }
    fn len(&self) -> usize {
        self.records.used / RECORD
    }
    fn field(&self, at: usize) -> io::Result<(TextSource, JsonSource)> {
        let record = &self.records.bytes()[at * RECORD..(at + 1) * RECORD];
        let key = self.source.bytes().slice(range(record, 16))?;
        let value = self.source.bytes().slice(range(record, 32))?;
        Ok((
            TextSource::new(key, TextEncoding::JsonString),
            JsonSource::new(value),
        ))
    }
}
fn read(record: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(record[at..at + 8].try_into().expect("fixed archive record"))
}
fn range(record: &[u8], at: usize) -> Range<u64> {
    read(record, at)..read(record, at + 8)
}
fn key<'a>(keys: &'a [u8], record: &[u8]) -> &'a str {
    std::str::from_utf8(&keys[read(record, 0) as usize..read(record, 8) as usize])
        .expect("decoded JSON key")
}

// In-place heapsort needs no second field directory or uncharged sort scratch.
// Cooperate during wide objects and long common key prefixes, rather than
// monopolizing the caller's async executor for an entire comparison/sort.
async fn sort_fields(records: &mut [[u8; RECORD]], keys: &[u8], stable: bool) {
    let length = records.len();
    for root in (0..length / 2).rev() {
        sift(records, keys, stable, root, length).await;
        cooperate().await;
    }
    for end in (1..records.len()).rev() {
        records.swap(0, end);
        sift(records, keys, stable, 0, end).await;
        cooperate().await;
    }
}
async fn sift(
    records: &mut [[u8; RECORD]],
    keys: &[u8],
    stable: bool,
    mut root: usize,
    end: usize,
) {
    while let Some(left) = root
        .checked_mul(2)
        .and_then(|root| root.checked_add(1))
        .filter(|left| *left < end)
    {
        let mut child = left;
        if left + 1 < end
            && compare(keys, &records[left], &records[left + 1], stable)
                .await
                .is_lt()
        {
            child += 1;
        }
        if !compare(keys, &records[root], &records[child], stable)
            .await
            .is_lt()
        {
            break;
        }
        records.swap(root, child);
        root = child;
    }
}
async fn compare(keys: &[u8], a: &[u8], b: &[u8], stable: bool) -> std::cmp::Ordering {
    let a_key = key(keys, a);
    let b_key = key(keys, b);
    let order = if let Some(order) = key_prefix_order(a_key, b_key, stable) {
        order
    } else {
        let mut a_units = key_units(a_key);
        let mut b_units = key_units(b_key);
        let mut compared = 0;
        loop {
            let a = a_units.next();
            let b = b_units.next();
            let order = a.cmp(&b);
            if !order.is_eq() || a.is_none() {
                break order;
            }
            compared += 1;
            if compared == 2048 {
                compared = 0;
                cooperate().await;
            }
        }
    };
    order.then_with(|| read(a, 48).cmp(&read(b, 48)))
}
async fn cooperate() {
    let mut yielded = false;
    std::future::poll_fn(|cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
    .await
}
