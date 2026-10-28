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

//! Forward JSON navigation over checked immutable source ranges.

use super::{
    ByteCursor, ChargedBuffer, JsonSource, SourceBudget, SourceBytes, TextEncoding, TextSource,
};
use std::{cmp::Ordering, io, ops::Range, sync::Arc};

pub mod number;
mod walk;
pub use walk::{JsonStructureEvent, JsonStructureValue, StructureCursor};

const READ_BYTES: usize = 32 * 1024;
// The initial stack covers serde_json's default depth; it grows within the envelope.
const INITIAL_NESTING_BYTES: usize = 128;
// serde_json starts at 128 and rejects the container that decrements it to zero.
const SERDE_VALUE_RECURSION_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonKind {
    Object,
    Array,
    String,
    Number,
    Bool,
    Null,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JsonCounts {
    pub objects: u64,
    pub arrays: u64,
    pub members: u64,
    pub elements: u64,
    pub leaves: u64,
}
impl JsonCounts {
    fn value(&mut self, kind: JsonKind) -> io::Result<()> {
        let count = match kind {
            JsonKind::Object => &mut self.objects,
            JsonKind::Array => &mut self.arrays,
            _ => &mut self.leaves,
        };
        *count = count
            .checked_add(1)
            .ok_or_else(|| invalid("JSON structure count overflow"))?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct JsonValue {
    pub source: JsonSource,
    pub kind: JsonKind,
}
impl JsonValue {
    pub fn text(&self) -> io::Result<TextSource> {
        if self.kind != JsonKind::String {
            return Err(invalid("JSON value is not a string"));
        }
        Ok(TextSource {
            bytes: self.source.bytes.clone(),
            encoding: TextEncoding::JsonString,
        })
    }
}
#[derive(Clone, Debug)]
pub struct JsonField {
    pub key: TextSource,
    pub value: JsonValue,
}

/// Byte ranges relative to the exact source passed to `ObjectCursor::open`.
/// Key ranges contain the complete quoted token; values exclude whitespace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonFieldSpans {
    pub key_range: Range<u64>,
    pub value_range: Range<u64>,
    pub kind: JsonKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonValueSpans {
    pub value_range: Range<u64>,
    pub kind: JsonKind,
}

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

#[derive(Debug)]
struct JsonSyntaxError {
    reason: &'static str,
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}
impl std::fmt::Display for JsonSyntaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for JsonSyntaxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| &**cause as &(dyn std::error::Error + 'static))
    }
}
fn syntax(reason: &'static str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        JsonSyntaxError {
            reason,
            cause: None,
        },
    )
}
fn number_syntax(error: io::Error) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        JsonSyntaxError {
            reason: "JSON number is outside serde Value's finite range",
            cause: Some(Box::new(error)),
        },
    )
}
/// Only local JSON grammar failures qualify; source IO and capability failures
/// retain their original error and must never become a synthetic JSON value.
pub fn is_syntax_error(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|error| error.is::<JsonSyntaxError>())
}

struct Reader {
    source: SourceBytes,
    cursor: Option<Box<dyn ByteCursor>>,
    budget: Arc<dyn SourceBudget>,
    buffer: Option<ChargedBuffer>,
    at: usize,
    used: usize,
    eof: bool,
    position: u64,
    legacy_value: bool,
}
impl Reader {
    async fn new(source: SourceBytes, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let (cursor, buffer) = match &source {
            SourceBytes::Inline(_) => (None, None),
            SourceBytes::Source(source) => (
                Some(source.open(budget.clone())),
                Some(
                    budget
                        .allocate(
                            source
                                .len()
                                .and_then(|len| usize::try_from(len).ok())
                                .unwrap_or(READ_BYTES)
                                .clamp(1, READ_BYTES),
                        )
                        .await?,
                ),
            ),
        };
        Ok(Self {
            source,
            cursor,
            budget,
            buffer,
            at: 0,
            used: 0,
            eof: false,
            position: 0,
            legacy_value: false,
        })
    }
    async fn peek(&mut self) -> io::Result<Option<u8>> {
        if let SourceBytes::Inline(bytes) = &self.source {
            return Ok(usize::try_from(self.position)
                .ok()
                .and_then(|at| bytes.get(at))
                .copied());
        }
        if self.at == self.used && !self.eof {
            let buffer = self
                .buffer
                .take()
                .ok_or_else(|| invalid("JSON reader lost its allocation"))?;
            let read = self
                .cursor
                .as_mut()
                .expect("source reader has a cursor")
                .read_chunk(buffer)
                .await?;
            if read.bytes_read > read.buffer.as_ref().len() || (read.bytes_read == 0 && !read.eof) {
                return Err(invalid("JSON source returned an invalid read"));
            }
            let read_end = self
                .position
                .checked_add(read.bytes_read as u64)
                .ok_or_else(|| invalid("JSON source position overflow"))?;
            if let SourceBytes::Source(source) = &self.source
                && source
                    .len()
                    .is_some_and(|len| read_end > len || (read.eof && read_end != len))
            {
                return Err(invalid("JSON source length disagrees with its bytes"));
            }
            self.buffer = Some(read.buffer);
            self.at = 0;
            self.used = read.bytes_read;
            self.eof = read.eof;
        }
        Ok((self.at < self.used).then(|| {
            self.buffer
                .as_ref()
                .expect("JSON read allocation is present")
                .as_ref()[self.at]
        }))
    }
    async fn take(&mut self) -> io::Result<Option<u8>> {
        let value = self.peek().await?;
        if value.is_some() {
            self.position = self
                .position
                .checked_add(1)
                .ok_or_else(|| invalid("JSON source position overflow"))?;
            self.at += 1;
        }
        Ok(value)
    }
    async fn byte(&mut self) -> io::Result<u8> {
        self.take()
            .await?
            .ok_or_else(|| syntax("truncated JSON source"))
    }
    async fn expect(&mut self, expected: u8) -> io::Result<()> {
        if self.byte().await? != expected {
            return Err(syntax("unexpected JSON token"));
        }
        Ok(())
    }
    async fn whitespace(&mut self) -> io::Result<()> {
        while self
            .peek()
            .await?
            .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.take().await?;
        }
        Ok(())
    }
    async fn end(&mut self) -> io::Result<()> {
        self.whitespace().await?;
        if self.peek().await?.is_some() {
            return Err(syntax("trailing JSON content"));
        }
        if let SourceBytes::Source(source) = &self.source
            && source.len().is_some_and(|len| len != self.position)
        {
            return Err(invalid("JSON source length disagrees with its bytes"));
        }
        Ok(())
    }
    fn range(&self, start: u64, end: u64) -> io::Result<JsonSource> {
        if start > end || end > self.position {
            return Err(invalid("JSON source range is invalid"));
        }
        Ok(JsonSource {
            bytes: self.source.slice(start..end)?,
        })
    }
    async fn hex(&mut self) -> io::Result<u16> {
        let mut value = 0u16;
        for _ in 0..4 {
            let digit = match self.byte().await? {
                byte @ b'0'..=b'9' => byte - b'0',
                byte @ b'a'..=b'f' => byte - b'a' + 10,
                byte @ b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(syntax("invalid JSON unicode escape")),
            };
            value = value * 16 + u16::from(digit);
        }
        Ok(value)
    }
    async fn string_char(&mut self) -> io::Result<Option<char>> {
        let byte = self.byte().await?;
        match byte {
            b'"' => Ok(None),
            b'\\' => Ok(Some(match self.byte().await? {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => {
                    let first = self.hex().await?;
                    let code = if (0xd800..=0xdbff).contains(&first) {
                        self.expect(b'\\').await?;
                        self.expect(b'u').await?;
                        let second = self.hex().await?;
                        if !(0xdc00..=0xdfff).contains(&second) {
                            return Err(syntax("invalid JSON surrogate pair"));
                        }
                        0x10000 + (u32::from(first) - 0xd800) * 0x400 + u32::from(second) - 0xdc00
                    } else {
                        u32::from(first)
                    };
                    char::from_u32(code).ok_or_else(|| syntax("invalid JSON unicode scalar"))?
                }
                _ => return Err(syntax("invalid JSON escape")),
            })),
            0..=0x1f => Err(syntax("unescaped JSON control character")),
            0x20..=0x7f => Ok(Some(char::from(byte))),
            _ => self.utf8_char(byte).await.map(Some),
        }
    }
    async fn utf8_char(&mut self, first: u8) -> io::Result<char> {
        if first.is_ascii() {
            return Ok(char::from(first));
        }
        let len = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Err(syntax("invalid text UTF-8")),
        };
        let mut bytes = [0u8; 4];
        bytes[0] = first;
        for destination in bytes.iter_mut().take(len).skip(1) {
            *destination = self.byte().await?;
        }
        let text = std::str::from_utf8(&bytes[..len]).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                JsonSyntaxError {
                    reason: "invalid JSON UTF-8",
                    cause: Some(Box::new(error)),
                },
            )
        })?;
        Ok(text
            .chars()
            .next()
            .expect("a decoded UTF-8 scalar is nonempty"))
    }
    async fn string(&mut self) -> io::Result<()> {
        self.expect(b'"').await?;
        while self.string_char().await?.is_some() {}
        Ok(())
    }
    async fn number_take(
        &mut self,
        validator: &mut Option<&mut number::NumberValidator>,
    ) -> io::Result<Option<u8>> {
        let byte = self.take().await?;
        if let (Some(validator), Some(byte)) = (validator.as_mut(), byte) {
            validator.push(byte).map_err(number_syntax)?;
        }
        Ok(byte)
    }
    async fn number_byte(
        &mut self,
        validator: &mut Option<&mut number::NumberValidator>,
    ) -> io::Result<u8> {
        self.number_take(validator)
            .await?
            .ok_or_else(|| syntax("truncated JSON number"))
    }
    async fn digits(
        &mut self,
        validator: &mut Option<&mut number::NumberValidator>,
    ) -> io::Result<usize> {
        let mut digits = 0usize;
        while self.peek().await?.is_some_and(|byte| byte.is_ascii_digit()) {
            self.number_take(validator).await?;
            digits = digits.saturating_add(1);
        }
        Ok(digits)
    }
    async fn number(&mut self) -> io::Result<()> {
        if self.legacy_value {
            // Only the embedded-Value consumer owns this fixed numeric state.
            // Ordinary canonical cursors do not retain it in their future frame.
            Box::pin(self.number_legacy()).await
        } else {
            self.number_lexeme(None).await
        }
    }
    async fn number_legacy(&mut self) -> io::Result<()> {
        let mut validator = number::NumberValidator::new();
        self.number_lexeme(Some(&mut validator)).await?;
        validator
            .into_representative_value()
            .map_err(number_syntax)?;
        Ok(())
    }
    async fn number_lexeme(
        &mut self,
        mut validator: Option<&mut number::NumberValidator>,
    ) -> io::Result<()> {
        if self.peek().await? == Some(b'-') {
            self.number_take(&mut validator).await?;
        }
        match self.number_byte(&mut validator).await? {
            b'0' => {}
            b'1'..=b'9' => {
                self.digits(&mut validator).await?;
            }
            _ => return Err(syntax("invalid JSON number")),
        }
        if self.peek().await? == Some(b'.') {
            self.number_take(&mut validator).await?;
            if self.digits(&mut validator).await? == 0 {
                return Err(syntax("invalid JSON fraction"));
            }
        }
        if matches!(self.peek().await?, Some(b'e' | b'E')) {
            self.number_take(&mut validator).await?;
            if matches!(self.peek().await?, Some(b'+' | b'-')) {
                self.number_take(&mut validator).await?;
            }
            if self.digits(&mut validator).await? == 0 {
                return Err(syntax("invalid JSON exponent"));
            }
        }
        Ok(())
    }
    async fn literal(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            self.expect(*byte).await?;
        }
        Ok(())
    }
    async fn begin_value(&mut self) -> io::Result<(JsonKind, Option<u8>)> {
        self.whitespace().await?;
        Ok(
            match self
                .peek()
                .await?
                .ok_or_else(|| syntax("missing JSON value"))?
            {
                b'{' => {
                    self.take().await?;
                    (JsonKind::Object, Some(0))
                }
                b'[' => {
                    self.take().await?;
                    (JsonKind::Array, Some(5))
                }
                b'"' => {
                    self.string().await?;
                    (JsonKind::String, None)
                }
                b't' => {
                    self.literal(b"true").await?;
                    (JsonKind::Bool, None)
                }
                b'f' => {
                    self.literal(b"false").await?;
                    (JsonKind::Bool, None)
                }
                b'n' => {
                    self.literal(b"null").await?;
                    (JsonKind::Null, None)
                }
                b'-' | b'0'..=b'9' => {
                    self.number().await?;
                    (JsonKind::Number, None)
                }
                _ => return Err(syntax("invalid JSON value")),
            },
        )
    }
    async fn scan_value(&mut self) -> io::Result<(u64, u64, JsonKind, JsonCounts)> {
        self.whitespace().await?;
        let start = self.position;
        let (kind, first) = self.begin_value().await?;
        let mut counts = JsonCounts::default();
        counts.value(kind)?;
        if let Some(first) = first {
            // Structural memory grows only with nesting and stays in the caller's
            // charged envelope. Token size never changes the work allocation.
            let mut stack = self.budget.allocate(INITIAL_NESTING_BYTES).await?;
            let mut depth = 1usize;
            if stack.as_mut().is_empty() {
                return Err(invalid("JSON nesting allocation is empty"));
            }
            stack.as_mut()[0] = first;
            while depth != 0 {
                self.whitespace().await?;
                let state = stack.as_ref()[depth - 1];
                let mut child = None;
                match state {
                    0 | 1 => {
                        if state == 0 && self.peek().await? == Some(b'}') {
                            self.take().await?;
                            depth -= 1;
                            continue;
                        }
                        self.string().await?;
                        self.whitespace().await?;
                        self.expect(b':').await?;
                        stack.as_mut()[depth - 1] = 4;
                        counts.members = counts
                            .members
                            .checked_add(1)
                            .ok_or_else(|| invalid("JSON member count overflow"))?;
                        let (kind, next) = self.begin_value().await?;
                        counts.value(kind)?;
                        child = next;
                    }
                    4 => match self.byte().await? {
                        b'}' => depth -= 1,
                        b',' => stack.as_mut()[depth - 1] = 1,
                        _ => return Err(syntax("invalid JSON object separator")),
                    },
                    5 | 6 => {
                        if state == 5 && self.peek().await? == Some(b']') {
                            self.take().await?;
                            depth -= 1;
                            continue;
                        }
                        stack.as_mut()[depth - 1] = 7;
                        counts.elements = counts
                            .elements
                            .checked_add(1)
                            .ok_or_else(|| invalid("JSON element count overflow"))?;
                        let (kind, next) = self.begin_value().await?;
                        counts.value(kind)?;
                        child = next;
                    }
                    7 => match self.byte().await? {
                        b']' => depth -= 1,
                        b',' => stack.as_mut()[depth - 1] = 6,
                        _ => return Err(syntax("invalid JSON array separator")),
                    },
                    _ => unreachable!("JSON scanner nesting state is internal"),
                }
                if let Some(child) = child {
                    if self.legacy_value && depth >= SERDE_VALUE_RECURSION_LIMIT - 1 {
                        return Err(syntax("serde Value recursion limit exceeded"));
                    }
                    if depth == stack.as_mut().len() {
                        let capacity = depth
                            .checked_mul(2)
                            .ok_or_else(|| invalid("JSON nesting allocation overflow"))?;
                        let mut grown = self.budget.allocate(capacity).await?;
                        if grown.as_mut().len() < capacity {
                            return Err(invalid("JSON nesting allocation is too small"));
                        }
                        grown.as_mut()[..depth].copy_from_slice(&stack.as_ref()[..depth]);
                        stack = grown;
                    }
                    stack.as_mut()[depth] = child;
                    depth += 1;
                }
            }
        }
        Ok((start, self.position, kind, counts))
    }
    async fn value_span(&mut self) -> io::Result<(u64, u64, JsonKind)> {
        let (start, end, kind, _) = self.scan_value().await?;
        Ok((start, end, kind))
    }
    async fn value(&mut self) -> io::Result<JsonValue> {
        let (start, end, kind) = self.value_span().await?;
        Ok(JsonValue {
            source: self.range(start, end)?,
            kind,
        })
    }
}

/// Classify an already-validated value without visiting its body. Iteration and
/// `inspect` separately check complete structure and source EOF.
pub async fn kind(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    match reader.peek().await? {
        Some(b'{') => Ok(JsonKind::Object),
        Some(b'[') => Ok(JsonKind::Array),
        Some(b'"') => Ok(JsonKind::String),
        Some(b't' | b'f') => Ok(JsonKind::Bool),
        Some(b'n') => Ok(JsonKind::Null),
        Some(b'-' | b'0'..=b'9') => Ok(JsonKind::Number),
        _ => Err(syntax("missing or invalid JSON value")),
    }
}

/// Validate a complete decoded byte stream without minting indexed subranges.
/// Transformed JSON must be published to indexed backing before field lookup.
pub async fn validate_bytes(
    source: &SourceBytes,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.clone(), budget).await?;
    let (_, _, kind) = reader.value_span().await?;
    reader.end().await?;
    Ok(kind)
}

/// Match the legacy `serde_json::Value` parse boundary for JSON embedded in
/// tool-error text: configured serde number semantics and the default recursion limit.
/// Ordinary already-validated canonical sources use `validate_bytes` instead.
pub async fn validate_value_bytes(
    source: &SourceBytes,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.clone(), budget).await?;
    reader.legacy_value = true;
    let (_, _, kind) = reader.value_span().await?;
    reader.end().await?;
    Ok(kind)
}

/// Count actual raw structure in one traversal, including duplicate members.
/// Opaque leaf length never increases directory accounting.
pub async fn measure(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonCounts> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    let (_, _, _, counts) = reader.scan_value().await?;
    reader.end().await?;
    Ok(counts)
}

pub async fn inspect(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonValue> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    let value = reader.value().await?;
    reader.end().await?;
    Ok(value)
}

pub struct ObjectCursor {
    reader: Reader,
    first: bool,
    done: bool,
}
impl ObjectCursor {
    pub async fn open(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes, budget).await?;
        reader.whitespace().await?;
        reader.expect(b'{').await?;
        Ok(Self {
            reader,
            first: true,
            done: false,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<JsonField>> {
        let Some(spans) = self.next_spans().await? else {
            return Ok(None);
        };
        let key = TextSource {
            bytes: self
                .reader
                .range(spans.key_range.start, spans.key_range.end)?
                .bytes,
            encoding: TextEncoding::JsonString,
        };
        let value = JsonValue {
            source: self
                .reader
                .range(spans.value_range.start, spans.value_range.end)?,
            kind: spans.kind,
        };
        Ok(Some(JsonField { key, value }))
    }
    /// A fixed-record directory can retain spans without allocating one source
    /// adapter per field. Its existing input source remains the read authority.
    pub async fn next_spans(&mut self) -> io::Result<Option<JsonFieldSpans>> {
        if self.done {
            return Ok(None);
        }
        self.reader.whitespace().await?;
        if self.reader.peek().await? == Some(b'}') {
            self.reader.take().await?;
            self.reader.end().await?;
            self.done = true;
            return Ok(None);
        }
        if !self.first {
            self.reader.expect(b',').await?;
            self.reader.whitespace().await?;
        }
        self.first = false;
        let key_start = self.reader.position;
        self.reader.string().await?;
        let key_end = self.reader.position;
        self.reader.whitespace().await?;
        self.reader.expect(b':').await?;
        let (start, end, kind) = self.reader.value_span().await?;
        Ok(Some(JsonFieldSpans {
            key_range: key_start..key_end,
            value_range: start..end,
            kind,
        }))
    }
}

pub struct ArrayCursor {
    reader: Reader,
    first: bool,
    done: bool,
}
impl ArrayCursor {
    pub async fn open(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes, budget).await?;
        reader.whitespace().await?;
        reader.expect(b'[').await?;
        Ok(Self {
            reader,
            first: true,
            done: false,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<JsonValue>> {
        let Some(span) = self.next_span().await? else {
            return Ok(None);
        };
        Ok(Some(JsonValue {
            source: self
                .reader
                .range(span.value_range.start, span.value_range.end)?,
            kind: span.kind,
        }))
    }
    /// Raw parent-relative offsets for an indexed array directory.
    pub async fn next_span(&mut self) -> io::Result<Option<JsonValueSpans>> {
        if self.done {
            return Ok(None);
        }
        self.reader.whitespace().await?;
        if self.reader.peek().await? == Some(b']') {
            self.reader.take().await?;
            self.reader.end().await?;
            self.done = true;
            return Ok(None);
        }
        if !self.first {
            self.reader.expect(b',').await?;
            self.reader.whitespace().await?;
        }
        self.first = false;
        let (start, end, kind) = self.reader.value_span().await?;
        Ok(Some(JsonValueSpans {
            value_range: start..end,
            kind,
        }))
    }
}

/// Locate a closed schema's fields in a single object traversal. Output slots
/// have the same order as `names`; the caller owns their directory accounting.
pub async fn fields(
    source: &JsonSource,
    names: &[&str],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<Option<JsonValue>>> {
    let mut output = vec![None; names.len()];
    let mut cursor = ObjectCursor::open(source.clone(), budget.clone()).await?;
    while let Some(field) = cursor.next().await? {
        for (index, name) in names.iter().enumerate() {
            if text_eq(&field.key, name, budget.clone()).await? {
                output[index] = Some(field.value.clone());
            }
        }
    }
    Ok(output)
}

pub async fn field(
    source: &JsonSource,
    path: &[&str],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<JsonValue>> {
    let mut value = JsonValue {
        source: source.clone(),
        kind: kind(source, budget.clone()).await?,
    };
    for name in path {
        if value.kind != JsonKind::Object {
            return Ok(None);
        }
        let mut found = fields(&value.source, &[*name], budget.clone()).await?;
        let Some(next) = found.pop().flatten() else {
            return Ok(None);
        };
        value = next;
    }
    Ok(Some(value))
}

pub async fn text_eq(
    source: &TextSource,
    expected: &str,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    let mut equal = true;
    match source.encoding {
        TextEncoding::Utf8 => {
            let mut bytes = expected.bytes();
            while let Some(byte) = reader.take().await? {
                if bytes.next() != Some(byte) {
                    return Ok(false);
                }
            }
            equal &= bytes.next().is_none();
        }
        TextEncoding::JsonString => {
            reader.expect(b'"').await?;
            let mut characters = expected.chars();
            while let Some(character) = reader.string_char().await? {
                if characters.next() != Some(character) {
                    return Ok(false);
                }
            }
            equal &= characters.next().is_none();
        }
    }
    reader.end().await?;
    Ok(equal)
}

struct TextReader {
    reader: Reader,
    encoding: TextEncoding,
}
impl TextReader {
    async fn new(source: &TextSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes.clone(), budget).await?;
        if source.encoding == TextEncoding::JsonString {
            reader.expect(b'"').await?;
        }
        Ok(Self {
            reader,
            encoding: source.encoding,
        })
    }
    async fn character(&mut self) -> io::Result<Option<char>> {
        let character = match self.encoding {
            TextEncoding::Utf8 => match self.reader.take().await? {
                Some(first) => Some(self.reader.utf8_char(first).await?),
                None => None,
            },
            TextEncoding::JsonString => self.reader.string_char().await?,
        };
        if character.is_none() {
            self.reader.end().await?;
        }
        Ok(character)
    }
}

/// Hash decoded Unicode bytes, so literal and escaped object keys share identity.
pub async fn text_digest(
    source: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let mut reader = TextReader::new(source, budget).await?;
    let mut digest = Sha256::new();
    let mut bytes = [0; 4];
    while let Some(character) = reader.character().await? {
        digest.update(character.encode_utf8(&mut bytes).as_bytes());
    }
    Ok(digest.finalize().into())
}

/// Digests may select candidates; equality still compares the decoded keys.
pub async fn text_source_eq(
    left: &TextSource,
    right: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    Ok(text_source_cmp(left, right, budget).await? == Ordering::Equal)
}

/// Compare decoded Unicode keys without retaining either token in memory.
pub async fn text_source_cmp(
    left: &TextSource,
    right: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Ordering> {
    let mut left = TextReader::new(left, budget.clone()).await?;
    let mut right = TextReader::new(right, budget).await?;
    loop {
        let left = left.character().await?;
        let right = right.character().await?;
        match left.cmp(&right) {
            Ordering::Equal if left.is_none() => return Ok(Ordering::Equal),
            Ordering::Equal => {}
            order => return Ok(order),
        }
    }
}

pub async fn bool_value(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<bool> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    let value = match reader.peek().await? {
        Some(b't') => {
            reader.literal(b"true").await?;
            true
        }
        Some(b'f') => {
            reader.literal(b"false").await?;
            false
        }
        _ => return Err(invalid("JSON value is not a boolean")),
    };
    reader.end().await?;
    Ok(value)
}

pub async fn u64_value(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<u64> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    let mut value = 0u64;
    let first = reader.byte().await?;
    if !first.is_ascii_digit() {
        return Err(invalid("JSON value is not an unsigned integer"));
    }
    value += u64::from(first - b'0');
    while let Some(byte @ b'0'..=b'9') = reader.peek().await? {
        if first == b'0' {
            return Err(syntax("JSON integer has a leading zero"));
        }
        reader.take().await?;
        value = value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u64::from(byte - b'0')))
            .ok_or_else(|| invalid("JSON integer exceeds u64"))?;
    }
    reader.end().await?;
    Ok(value)
}

#[cfg(test)]
mod tests;
