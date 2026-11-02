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

//! Locate closed semantic leaves without retaining their bodies.

use crate::StoreError;
use maka_agent_facts::history::{
    RowPosition,
    semantic::directory::{
        AttachmentDirectory, ByteRange, ChildDirectory, InputDirectory, JsonSpan, ListKind,
        MediaDirectory, PartDirectory, PartSource, PayloadDirectory, RowDirectory,
        StorageDirectory, TextSpan, ToolDirectory, ToolPartDirectory, ValueKind,
    },
};
use maka_agent_facts::model::{
    TextKind,
    prompt_source::source::{DecodedTextMeasure, RawJsonMeasure},
};
use sha2::{Digest, Sha256};
use std::io::{self, BufReader, Read};

fn invalid(message: &'static str) -> StoreError {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}
fn required<T>(value: Option<T>) -> Result<T, StoreError> {
    value.ok_or_else(|| invalid("missing semantic directory field"))
}

// Schema names are bounded; unknown names are consumed without retaining them.
struct Name {
    bytes: [u8; 64],
    len: usize,
}
impl Default for Name {
    fn default() -> Self {
        Self {
            bytes: [0; 64],
            len: 0,
        }
    }
}
impl Name {
    fn is(&self, expected: &str) -> bool {
        self.len == expected.len() && self.bytes.get(..self.len) == Some(expected.as_bytes())
    }
}
// Hash in blocks so large opaque and text leaves do not call SHA per byte.
struct LeafHash {
    hash: Sha256,
    buffer: [u8; 4096],
    len: usize,
    bytes: u64,
}
impl LeafHash {
    fn new() -> Self {
        Self {
            hash: Sha256::new(),
            buffer: [0; 4096],
            len: 0,
            bytes: 0,
        }
    }
    fn update(&mut self, mut input: &[u8]) {
        self.bytes += input.len() as u64;
        while !input.is_empty() {
            let len = (self.buffer.len() - self.len).min(input.len());
            self.buffer[self.len..self.len + len].copy_from_slice(&input[..len]);
            self.len += len;
            input = &input[len..];
            if self.len == self.buffer.len() {
                self.hash.update(self.buffer);
                self.len = 0;
            }
        }
    }
    fn finish(mut self) -> [u8; 32] {
        self.hash.update(&self.buffer[..self.len]);
        self.hash.finalize().into()
    }
}
struct Scan<'a> {
    reader: BufReader<&'a mut dyn Read>,
    look: Option<u8>,
    offset: u64,
    raw: Option<LeafHash>,
}
impl<'a> Scan<'a> {
    fn new(reader: &'a mut dyn Read) -> Self {
        Self {
            reader: BufReader::new(reader),
            look: None,
            offset: 0,
            raw: None,
        }
    }
    fn peek(&mut self) -> Result<Option<u8>, StoreError> {
        if self.look.is_none() {
            let mut byte = [0];
            if self.reader.read(&mut byte)? != 0 {
                self.look = Some(byte[0]);
            }
        }
        Ok(self.look)
    }
    fn take(&mut self) -> Result<u8, StoreError> {
        let byte = self
            .peek()?
            .ok_or_else(|| invalid("truncated semantic JSON"))?;
        self.look = None;
        self.offset += 1;
        if let Some(hash) = &mut self.raw {
            hash.update(&[byte]);
        }
        Ok(byte)
    }
    fn ws(&mut self) -> Result<(), StoreError> {
        while self.peek()?.is_some_and(|b| b.is_ascii_whitespace()) {
            self.take()?;
        }
        Ok(())
    }
    fn expect(&mut self, byte: u8) -> Result<(), StoreError> {
        self.ws()?;
        if self.take()? != byte {
            return Err(invalid("unexpected semantic JSON token"));
        }
        Ok(())
    }
    fn end(&mut self) -> Result<(), StoreError> {
        self.ws()?;
        if self.peek()?.is_some() {
            return Err(invalid("trailing semantic JSON"));
        }
        Ok(())
    }
    fn hex4(&mut self) -> Result<u32, StoreError> {
        let mut value = 0;
        for _ in 0..4 {
            let b = self.take()?;
            let digit = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => return Err(invalid("invalid JSON unicode escape")),
            };
            value = value * 16 + u32::from(digit);
        }
        Ok(value)
    }
    fn string(&mut self, mut decoded: impl FnMut(&[u8])) -> Result<(), StoreError> {
        self.expect(b'"')?;
        loop {
            match self.take()? {
                b'"' => return Ok(()),
                b'\\' => {
                    let escaped = self.take()?;
                    let byte = match escaped {
                        b'"' | b'\\' | b'/' => Some(escaped),
                        b'b' => Some(8),
                        b'f' => Some(12),
                        b'n' => Some(10),
                        b'r' => Some(13),
                        b't' => Some(9),
                        b'u' => None,
                        _ => return Err(invalid("invalid JSON string escape")),
                    };
                    if let Some(byte) = byte {
                        decoded(&[byte]);
                    } else {
                        let first = self.hex4()?;
                        let code = if (0xd800..=0xdbff).contains(&first) {
                            if self.take()? != b'\\' || self.take()? != b'u' {
                                return Err(invalid("missing JSON low surrogate"));
                            }
                            let low = self.hex4()?;
                            if !(0xdc00..=0xdfff).contains(&low) {
                                return Err(invalid("invalid JSON low surrogate"));
                            }
                            0x10000 + ((first - 0xd800) << 10) + low - 0xdc00
                        } else {
                            first
                        };
                        let ch = char::from_u32(code)
                            .ok_or_else(|| invalid("invalid JSON unicode scalar"))?;
                        let mut bytes = [0; 4];
                        decoded(ch.encode_utf8(&mut bytes).as_bytes());
                    }
                }
                byte @ 0..=31 => {
                    let _ = byte;
                    return Err(invalid("control byte in JSON string"));
                }
                byte @ 32..=127 => decoded(&[byte]),
                first => {
                    let len = match first {
                        0xc2..=0xdf => 2,
                        0xe0..=0xef => 3,
                        0xf0..=0xf4 => 4,
                        _ => return Err(invalid("invalid JSON UTF-8")),
                    };
                    let mut bytes = [0; 4];
                    bytes[0] = first;
                    for byte in &mut bytes[1..len] {
                        *byte = self.take()?;
                    }
                    std::str::from_utf8(&bytes[..len])
                        .map_err(|_| invalid("invalid JSON UTF-8"))?;
                    decoded(&bytes[..len]);
                }
            }
        }
    }
    fn name(&mut self) -> Result<Name, StoreError> {
        let mut name = Name::default();
        self.string(|bytes| {
            for &byte in bytes {
                if name.len < name.bytes.len() {
                    name.bytes[name.len] = byte;
                }
                name.len = name.len.saturating_add(1);
            }
        })?;
        Ok(name)
    }
    fn text(&mut self) -> Result<TextSpan, StoreError> {
        self.ws()?;
        let start = self.offset;
        let mut hash = LeafHash::new();
        self.string(|chunk| {
            hash.update(chunk);
        })?;
        Ok(TextSpan {
            range: ByteRange {
                start,
                len: self.offset - start,
            },
            measure: DecodedTextMeasure {
                bytes: hash.bytes,
                sha256: hash.finish(),
            },
        })
    }
    fn literal(&mut self, expected: &[u8]) -> Result<(), StoreError> {
        self.ws()?;
        for &byte in expected {
            if self.take()? != byte {
                return Err(invalid("invalid JSON literal"));
            }
        }
        Ok(())
    }
    fn boolean(&mut self) -> Result<bool, StoreError> {
        self.ws()?;
        if self.peek()? == Some(b't') {
            self.literal(b"true")?;
            Ok(true)
        } else {
            self.literal(b"false")?;
            Ok(false)
        }
    }
    fn null(&mut self) -> Result<bool, StoreError> {
        self.ws()?;
        if self.peek()? == Some(b'n') {
            self.literal(b"null")?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    fn uint(&mut self) -> Result<u64, StoreError> {
        self.ws()?;
        let mut value = 0u64;
        let mut count = 0;
        while let Some(byte @ b'0'..=b'9') = self.peek()? {
            self.take()?;
            count += 1;
            value = value
                .checked_mul(10)
                .and_then(|v| v.checked_add(u64::from(byte - b'0')))
                .ok_or_else(|| invalid("semantic integer overflow"))?;
        }
        if count == 0 {
            return Err(invalid("missing semantic integer"));
        }
        Ok(value)
    }
    fn object(
        &mut self,
        mut field: impl FnMut(&mut Self, Name) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        self.expect(b'{')?;
        self.ws()?;
        if self.peek()? == Some(b'}') {
            self.take()?;
            return Ok(());
        }
        loop {
            let key = self.name()?;
            self.expect(b':')?;
            field(self, key)?;
            self.ws()?;
            match self.take()? {
                b'}' => return Ok(()),
                b',' => (),
                _ => return Err(invalid("invalid JSON object separator")),
            }
        }
    }
    fn array(
        &mut self,
        mut item: impl FnMut(&mut Self, u64) -> Result<(), StoreError>,
    ) -> Result<u64, StoreError> {
        self.expect(b'[')?;
        self.ws()?;
        let mut count = 0;
        if self.peek()? == Some(b']') {
            self.take()?;
            return Ok(0);
        }
        loop {
            item(self, count)?;
            count += 1;
            self.ws()?;
            match self.take()? {
                b']' => return Ok(count),
                b',' => (),
                _ => return Err(invalid("invalid JSON array separator")),
            }
        }
    }
    // Opaque leaves never recurse or retain provider object keys or values.
    fn skip(&mut self) -> Result<ValueKind, StoreError> {
        self.ws()?;
        let first = self.peek()?.ok_or_else(|| invalid("missing JSON value"))?;
        let kind = match first {
            b'n' => ValueKind::Null,
            b't' | b'f' => ValueKind::Bool,
            b'"' => ValueKind::String,
            b'[' => ValueKind::Array,
            b'{' => ValueKind::Object,
            b'-' | b'0'..=b'9' => ValueKind::Number,
            _ => return Err(invalid("invalid JSON value")),
        };
        if first == b'"' {
            self.string(|_| {})?;
            return Ok(kind);
        }
        if first == b'n' {
            self.literal(b"null")?;
            return Ok(kind);
        }
        if first == b't' {
            self.literal(b"true")?;
            return Ok(kind);
        }
        if first == b'f' {
            self.literal(b"false")?;
            return Ok(kind);
        }
        if matches!(first, b'[' | b'{') {
            let mut depth = 0u64;
            loop {
                match self
                    .peek()?
                    .ok_or_else(|| invalid("truncated opaque JSON"))?
                {
                    b'"' => self.string(|_| {})?,
                    b'[' | b'{' => {
                        self.take()?;
                        depth += 1;
                    }
                    b']' | b'}' => {
                        self.take()?;
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {
                        self.take()?;
                    }
                }
            }
        } else {
            while self
                .peek()?
                .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b',' | b']' | b'}'))
            {
                self.take()?;
            }
        }
        Ok(kind)
    }
    fn json(&mut self) -> Result<JsonSpan, StoreError> {
        self.ws()?;
        let start = self.offset;
        self.raw = Some(LeafHash::new());
        let kind = self.skip()?;
        let hash = self
            .raw
            .take()
            .ok_or_else(|| invalid("missing raw JSON hash"))?;
        let len = self.offset - start;
        Ok(JsonSpan {
            range: ByteRange { start, len },
            measure: RawJsonMeasure {
                bytes: len,
                sha256: hash.finish(),
            },
            kind,
        })
    }
    fn optional_json(&mut self) -> Result<Option<JsonSpan>, StoreError> {
        if self.null()? {
            Ok(None)
        } else {
            self.json().map(Some)
        }
    }
    fn optional_text(&mut self) -> Result<Option<TextSpan>, StoreError> {
        if self.null()? {
            Ok(None)
        } else {
            self.text().map(Some)
        }
    }
    fn position(&mut self) -> Result<RowPosition, StoreError> {
        let (mut source, mut item) = (None, None);
        self.object(|s, k| {
            if k.is("sourceSequence") {
                source = Some(s.uint()?);
            } else if k.is("itemIndex") {
                item = Some(s.uint()?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        Ok(RowPosition {
            source_sequence: required(source)?,
            item_index: required(item)?,
        })
    }
    fn text_kind(&mut self) -> Result<TextKind, StoreError> {
        let name = self.name()?;
        if name.is("text") {
            Ok(TextKind::Text)
        } else if name.is("thinking") {
            Ok(TextKind::Thinking)
        } else {
            Err(invalid("unknown semantic text kind"))
        }
    }
    fn part_source(&mut self) -> Result<PartSource, StoreError> {
        let mut result = None;
        self.object(|s, k| {
            if k.is("Complete") {
                result = Some(PartSource::Complete(s.position()?));
            } else {
                return Err(invalid("unknown semantic part source"));
            }
            Ok(())
        })?;
        required(result)
    }
    fn row_kind(&mut self) -> Result<RowDirectory, StoreError> {
        let mut result = None;
        self.object(|s, variant| {
            let (mut payload, mut part, mut model, mut route, mut call, mut name) =
                (None, None, None, None, None, None);
            let (mut steering, mut custom, mut is_error, mut archived) = (None, None, None, None);
            s.object(|s, k| {
                if k.is("payload") {
                    if variant.is("AssistantPart") {
                        part = Some(s.part_source()?);
                    } else {
                        payload = Some(s.position()?);
                    }
                } else if k.is("model_id") {
                    model = Some(s.text()?);
                } else if k.is("route_identity") {
                    route = Some(s.text()?);
                } else if k.is("call_id") {
                    call = Some(s.text()?);
                } else if k.is("name") {
                    name = Some(s.text()?);
                } else if k.is("steering") {
                    steering = Some(s.boolean()?);
                } else if k.is("custom") {
                    custom = Some(s.boolean()?);
                } else if k.is("is_error") {
                    is_error = Some(s.boolean()?);
                } else if k.is("archived") {
                    archived = Some(s.boolean()?);
                } else {
                    s.skip()?;
                }
                Ok(())
            })?;
            result = Some(if variant.is("User") {
                RowDirectory::User {
                    payload: required(payload)?,
                    steering: required(steering)?,
                }
            } else if variant.is("ImportedUser") {
                RowDirectory::ImportedUser {
                    payload: required(payload)?,
                }
            } else if variant.is("ImportedAssistant") {
                RowDirectory::ImportedAssistant {
                    payload: required(payload)?,
                }
            } else if variant.is("ExecutorText") {
                RowDirectory::ExecutorText {
                    payload: required(payload)?,
                }
            } else if variant.is("AssistantPart") {
                RowDirectory::AssistantPart {
                    model_id: required(model)?,
                    route_identity: required(route)?,
                    payload: required(part)?,
                }
            } else if variant.is("ToolResult") {
                RowDirectory::ToolResult {
                    payload: required(payload)?,
                    call_id: required(call)?,
                    name: required(name)?,
                    custom: required(custom)?,
                    is_error: required(is_error)?,
                    archived: required(archived)?,
                }
            } else if variant.is("Notification") {
                RowDirectory::Notification {
                    payload: required(payload)?,
                    call_id: required(call)?,
                    custom: required(custom)?,
                }
            } else if variant.is("UnknownTool") {
                RowDirectory::UnknownTool {
                    call_id: required(call)?,
                    name: required(name)?,
                    custom: required(custom)?,
                }
            } else {
                return Err(invalid("unknown semantic row variant"));
            });
            Ok(())
        })?;
        required(result)
    }
}

pub(super) fn row(reader: &mut dyn Read) -> Result<RowDirectory, StoreError> {
    let mut scan = Scan::new(reader);
    let mut result = None;
    scan.object(|s, k| {
        if k.is("kind") {
            result = Some(s.row_kind()?);
        } else {
            s.skip()?;
        }
        Ok(())
    })?;
    scan.end()?;
    required(result)
}

impl Scan<'_> {
    fn storage(&mut self) -> Result<StorageDirectory, StoreError> {
        let (mut kind, mut session, mut relative, mut absolute, mut reference) =
            (None, None, None, None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("sessionId") {
                session = Some(s.text()?);
            } else if k.is("relativePath") {
                relative = Some(s.text()?);
            } else if k.is("absolutePath") {
                absolute = Some(s.text()?);
            } else if k.is("refId") {
                reference = Some(s.text()?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        let kind = required(kind)?;
        if kind.is("session_file") {
            Ok(StorageDirectory::SessionFile {
                session_id: required(session)?,
                relative_path: required(relative)?,
            })
        } else if kind.is("workspace_file") {
            Ok(StorageDirectory::WorkspaceFile {
                relative_path: required(relative)?,
            })
        } else if kind.is("external_file") {
            Ok(StorageDirectory::ExternalFile {
                absolute_path: required(absolute)?,
            })
        } else if kind.is("session_context") {
            Ok(StorageDirectory::SessionContext {
                session_id: required(session)?,
                ref_id: required(reference)?,
            })
        } else {
            Err(invalid("unknown semantic storage kind"))
        }
    }
    fn media(&mut self) -> Result<MediaDirectory, StoreError> {
        let (mut reference, mut mime_type, mut detail) = (None, None, None);
        self.object(|s, k| {
            if k.is("ref") {
                reference = Some(s.storage()?);
            } else if k.is("mimeType") {
                mime_type = Some(s.text()?);
            } else if k.is("detail") {
                detail = s.optional_text()?;
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        Ok(MediaDirectory {
            reference: required(reference)?,
            mime_type: required(mime_type)?,
            detail,
        })
    }
    fn attachment(&mut self) -> Result<AttachmentDirectory, StoreError> {
        let (mut kind, mut name, mut mime_type, mut reference) = (None, None, None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("name") {
                name = Some(s.text()?);
            } else if k.is("mimeType") {
                mime_type = Some(s.text()?);
            } else if k.is("ref") {
                reference = Some(s.storage()?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        let kind = required(kind)?;
        if !["image", "pdf", "doc", "code", "other"]
            .iter()
            .any(|k| kind.is(k))
        {
            return Err(invalid("unknown attachment kind"));
        }
        Ok(AttachmentDirectory {
            image: kind.is("image"),
            name: required(name)?,
            mime_type: required(mime_type)?,
            reference: required(reference)?,
        })
    }
    fn quote(&mut self) -> Result<ChildDirectory, StoreError> {
        let (mut label, mut source, mut text) = (None, None, None);
        self.object(|s, k| {
            if k.is("text") {
                text = Some(s.text()?);
            } else if k.is("label") {
                label = s.optional_text()?;
            } else if k.is("source") {
                source = s.optional_json()?;
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        Ok(ChildDirectory::Quote {
            label,
            source,
            text: required(text)?,
        })
    }
    fn tool_part(&mut self) -> Result<ToolPartDirectory, StoreError> {
        let (mut kind, mut text, mut image, mut audio) = (None, None, None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("text") {
                text = Some(s.text()?);
            } else if k.is("image") {
                image = Some(s.media()?);
            } else if k.is("audio") {
                audio = Some(s.media()?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        let kind = required(kind)?;
        if kind.is("text") {
            Ok(ToolPartDirectory::Text(required(text)?))
        } else if kind.is("artifact") {
            Ok(ToolPartDirectory::Artifact(required(image)?))
        } else if kind.is("audio") {
            Ok(ToolPartDirectory::Audio(required(audio)?))
        } else {
            Err(invalid("unknown tool projection part"))
        }
    }
    fn tool(
        &mut self,
        child: &mut impl FnMut(ListKind, u64, ChildDirectory) -> Result<(), StoreError>,
    ) -> Result<ToolDirectory, StoreError> {
        let (mut kind, mut text, mut value, mut parts) = (None, None, None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("text") {
                text = Some(s.text()?);
            } else if k.is("value") {
                value = Some(s.json()?);
            } else if k.is("parts") {
                parts = Some(s.array(|s, index| {
                    let part = s.tool_part()?;
                    child(ListKind::ToolParts, index, ChildDirectory::ToolPart(part))
                })?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        let kind = required(kind)?;
        if kind.is("text") {
            Ok(ToolDirectory::Text(required(text)?))
        } else if kind.is("json") {
            Ok(ToolDirectory::Json(required(value)?))
        } else if kind.is("content") {
            Ok(ToolDirectory::Content {
                parts: required(parts)?,
            })
        } else if kind.is("failure") {
            Ok(ToolDirectory::Failure)
        } else {
            Err(invalid("unknown tool projection"))
        }
    }
    fn user(
        &mut self,
        child: &mut impl FnMut(ListKind, u64, ChildDirectory) -> Result<(), StoreError>,
    ) -> Result<PayloadDirectory, StoreError> {
        let (mut text, mut quotes, mut attachments, mut directory_references) = (None, 0, 0, None);
        self.object(|s, k| {
            if k.is("text") {
                text = Some(s.text()?);
            } else if k.is("directory_references") {
                directory_references = s.optional_json()?;
            } else if k.is("quotes") {
                if !s.null()? {
                    quotes = s.array(|s, index| {
                        let quote = s.quote()?;
                        child(ListKind::Quotes, index, quote)
                    })?;
                }
            } else if k.is("attachments") {
                if !s.null()? {
                    attachments = s.array(|s, index| {
                        let attachment = s.attachment()?;
                        child(
                            ListKind::Attachments,
                            index,
                            ChildDirectory::Attachment(attachment),
                        )
                    })?;
                }
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        Ok(PayloadDirectory::User {
            text: required(text)?,
            quotes,
            attachments,
            directory_references,
        })
    }
    fn input(&mut self) -> Result<InputDirectory, StoreError> {
        let (mut kind, mut input) = (None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("data") {
                let kind = kind
                    .as_ref()
                    .ok_or_else(|| invalid("tool input tag must precede data"))?;
                if kind.is("json") {
                    input = Some(InputDirectory::Json(s.json()?));
                } else if kind.is("invalid_json") {
                    s.object(|s, k| {
                        if k.is("raw") {
                            input = Some(InputDirectory::Text(s.text()?));
                        } else {
                            s.skip()?;
                        }
                        Ok(())
                    })?;
                } else {
                    return Err(invalid("unknown tool input kind"));
                }
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        required(input)
    }
    fn call(&mut self) -> Result<PartDirectory, StoreError> {
        let (mut id, mut name, mut input, mut provider_executed, mut provider_options) =
            (None, None, None, None, None);
        self.object(|s, k| {
            if k.is("id") {
                id = Some(s.text()?);
            } else if k.is("name") {
                name = Some(s.text()?);
            } else if k.is("input") {
                input = Some(s.input()?);
            } else if k.is("provider_executed") {
                provider_executed = Some(s.boolean()?);
            } else if k.is("provider_options") {
                provider_options = s.optional_json()?;
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        Ok(PartDirectory::ToolCall {
            id: required(id)?,
            name: required(name)?,
            input: required(input)?,
            provider_executed: required(provider_executed)?,
            provider_options,
        })
    }
    fn part(&mut self) -> Result<PartDirectory, StoreError> {
        let (
            mut kind,
            mut text_kind,
            mut text,
            mut provider_options,
            mut call,
            mut id,
            mut name,
            mut output,
            mut is_error,
        ) = (None, None, None, None, None, None, None, None, None);
        self.object(|s, k| {
            if k.is("kind") {
                kind = Some(s.name()?);
            } else if k.is("text_kind") {
                text_kind = Some(s.text_kind()?);
            } else if k.is("text") {
                text = Some(s.text()?);
            } else if k.is("provider_options") {
                provider_options = s.optional_json()?;
            } else if k.is("call") {
                call = Some(s.call()?);
            } else if k.is("id") {
                id = Some(s.text()?);
            } else if k.is("name") {
                name = Some(s.text()?);
            } else if k.is("output") {
                output = Some(s.json()?);
            } else if k.is("is_error") {
                is_error = Some(s.boolean()?);
            } else {
                s.skip()?;
            }
            Ok(())
        })?;
        let kind = required(kind)?;
        if kind.is("source") {
            Ok(PartDirectory::Source)
        } else if kind.is("text") {
            Ok(PartDirectory::Text {
                text_kind: required(text_kind)?,
                text: required(text)?,
                provider_options,
            })
        } else if kind.is("tool_call") {
            required(call)
        } else if kind.is("tool_result") {
            Ok(PartDirectory::ToolResult {
                id: required(id)?,
                name: required(name)?,
                output: required(output)?,
                is_error: required(is_error)?,
                provider_options,
            })
        } else {
            Err(invalid("unknown model part"))
        }
    }
}

pub(super) enum PayloadRoot {
    Payload,
    ToolProjection,
    ModelPart,
}

pub(super) fn payload(
    reader: &mut dyn Read,
    root: PayloadRoot,
    mut child: impl FnMut(ListKind, u64, ChildDirectory) -> Result<(), StoreError>,
) -> Result<(PayloadDirectory, u64), StoreError> {
    let mut scan = Scan::new(reader);
    let directory = match root {
        PayloadRoot::ToolProjection => PayloadDirectory::Tool(scan.tool(&mut child)?),
        PayloadRoot::ModelPart => PayloadDirectory::Part(scan.part()?),
        PayloadRoot::Payload => {
            let mut directory = None;
            scan.object(|s, k| {
                directory = Some(if k.is("User") {
                    s.user(&mut child)?
                } else if k.is("Text") {
                    PayloadDirectory::Text(s.text()?)
                } else if k.is("Part") {
                    PayloadDirectory::Part(s.part()?)
                } else if k.is("Tool") {
                    PayloadDirectory::Tool(s.tool(&mut child)?)
                } else {
                    return Err(invalid("unknown semantic payload"));
                });
                Ok(())
            })?;
            required(directory)?
        }
    };
    scan.end()?;
    Ok((directory, scan.offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Split<'a>(&'a [u8]);
    impl Read for Split<'_> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let len = out.len().min(self.0.len()).min(3);
            out[..len].copy_from_slice(&self.0[..len]);
            self.0 = &self.0[len..];
            Ok(len)
        }
    }
    fn text_matches(bytes: &[u8], span: TextSpan, expected: &str) {
        let start = span.range.start as usize;
        let end = start + span.range.len as usize;
        assert_eq!(
            serde_json::from_slice::<String>(&bytes[start..end]).unwrap(),
            expected
        );
        assert_eq!(span.measure.bytes, expected.len() as u64);
        assert_eq!(
            span.measure.sha256,
            <[u8; 32]>::from(Sha256::digest(expected.as_bytes()))
        );
    }
    fn json_matches(bytes: &[u8], span: JsonSpan, expected: serde_json::Value) {
        let start = span.range.start as usize;
        let end = start + span.range.len as usize;
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes[start..end]).unwrap(),
            expected
        );
        assert_eq!(span.measure.bytes, span.range.len);
        assert_eq!(
            span.measure.sha256,
            <[u8; 32]>::from(Sha256::digest(&bytes[start..end]))
        );
    }
    #[test]
    fn actual_escaped_text_and_opaque_bytes_are_measured_across_reads() {
        let bytes=r#"{"Part":{"kind":"text","text_kind":"text","text":"x\n\uD83D\uDE80é","provider_options": { "kind":"text", "text":["\\\"",null,7] }}}"#.as_bytes();
        let (directory, len) =
            payload(&mut Split(bytes), super::PayloadRoot::Payload, |_, _, _| {
                panic!("no child lists")
            })
            .unwrap();
        assert_eq!(len, bytes.len() as u64);
        let PayloadDirectory::Part(PartDirectory::Text {
            text,
            provider_options: Some(options),
            ..
        }) = directory
        else {
            panic!("text directory")
        };
        text_matches(bytes, text, "x\n🚀é");
        json_matches(
            bytes,
            options,
            json!({"kind":"text","text":["\\\"",null,7]}),
        );
        let start = options.range.start as usize;
        assert_eq!(&bytes[start..start + 2], b"{ ");
    }
    #[test]
    fn malformed_strings_truncation_and_child_errors_surface() {
        for bytes in [
            br#"{"Text":"\uD800"}"#.as_slice(),
            br#"{"Text":"unterminated}"#.as_slice(),
            br#"{"Tool":{"kind":"json","value":{"nested":[1,2]}}"#.as_slice(),
        ] {
            assert!(
                payload(
                    &mut Split(bytes),
                    super::PayloadRoot::Payload,
                    |_, _, _| Ok(())
                )
                .is_err()
            );
        }
        let bytes = br#"{"Tool":{"kind":"content","parts":[{"kind":"text","text":"x"}]}}"#;
        let error = payload(&mut Split(bytes), super::PayloadRoot::Payload, |_, _, _| {
            Err(invalid("child persistence failed"))
        })
        .unwrap_err();
        assert!(error.to_string().contains("child persistence failed"));
    }
}
