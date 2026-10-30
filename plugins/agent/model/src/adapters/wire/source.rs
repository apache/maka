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

//! Bounded source fragments shared by the native provider encoders.

use bytes::Bytes;

mod content_array;
mod object;
use maka_agent_facts::model::prompt_source::source::{JsonSource, SourceBytes, TextSource};

/// Escaped fragments exclude their surrounding JSON string quotes.
#[derive(Clone, Debug)]
pub(in crate::adapters) enum SourceFragment {
    Literal(Bytes),
    OwnedLiteral {
        bytes: Bytes,
        capacity: usize,
    },
    Raw(JsonSource),
    OwnedRaw {
        source: JsonSource,
        metadata_bytes: usize,
    },
    Text(TextSource),
    JsonString(JsonSource),
    OwnedJsonString {
        source: JsonSource,
        metadata_bytes: usize,
    },
    LossyText(SourceBytes),
    Base64(SourceBytes),
}
impl SourceFragment {
    pub(in crate::adapters) fn owned_raw(source: JsonSource, metadata_bytes: usize) -> Self {
        Self::OwnedRaw {
            source,
            metadata_bytes,
        }
    }
    pub(in crate::adapters) fn owned(bytes: Vec<u8>) -> Self {
        let capacity = bytes.capacity();
        Self::OwnedLiteral {
            bytes: Bytes::from(bytes),
            capacity,
        }
    }
    pub(in crate::adapters) fn literal(bytes: &'static [u8]) -> Self {
        Self::Literal(Bytes::from_static(bytes))
    }
}

#[derive(Clone)]
pub(in crate::adapters) struct SourceItem {
    pub fragments: std::sync::Arc<[SourceFragment]>,
    pub metadata: Option<maka_agent_facts::model::prompt_source::WireItemMetadata>,
    /// New codec adapter backing, recorded at creation before replay clones.
    pub owned_bytes: usize,
}

use maka_agent_facts::model::prompt_source::source::{ByteCursor, SourceBudget, TextEncoding};
use maka_provider_protocol::json_stream::pull::{
    Base64Encoder, JsonEscape, JsonStringDecoder, Transform, Utf8Lossy,
};
use std::{io, sync::Arc};

const INPUT_QUANTUM: usize = 2048;
const BASE64_INPUT_QUANTUM: usize = 8 * 1024;
// Two carried bytes plus final padding, without JSON's sixfold escape envelope.
const BASE64_OUTPUT_QUANTUM: usize = (BASE64_INPUT_QUANTUM + 2).div_ceil(3) * 4;
enum Input {
    Inline {
        bytes: Bytes,
        offset: usize,
    },
    Source {
        factory: Arc<dyn maka_agent_facts::model::prompt_source::source::ByteSource>,
        cursor: Option<Box<dyn ByteCursor>>,
    },
}
enum Conversion {
    Raw,
    Escape(JsonEscape),
    DecodeEscape {
        decoder: JsonStringDecoder,
        escape: JsonEscape,
    },
    Base64(Base64Encoder),
    Lossy {
        decoder: Utf8Lossy,
        escape: JsonEscape,
    },
}
/// Owns only codec state between pulls; every source read settles before return.
pub(in crate::adapters) struct FragmentCursor {
    owner: SourceFragment,
    input: Input,
    conversion: Conversion,
    finished: bool,
}
impl FragmentCursor {
    pub(in crate::adapters) fn new(fragment: SourceFragment) -> Self {
        let owner = fragment.clone();
        let (bytes, conversion) = match fragment {
            SourceFragment::Literal(bytes) | SourceFragment::OwnedLiteral { bytes, .. } => {
                (SourceBytes::Inline(bytes), Conversion::Raw)
            }
            SourceFragment::Raw(json) | SourceFragment::OwnedRaw { source: json, .. } => {
                (json.into_bytes(), Conversion::Raw)
            }
            SourceFragment::Text(text) => {
                let (bytes, encoding) = text.into_parts();
                (
                    bytes,
                    match encoding {
                        TextEncoding::Utf8 => Conversion::Escape(JsonEscape::new()),
                        TextEncoding::JsonString => Conversion::DecodeEscape {
                            decoder: JsonStringDecoder::new(),
                            escape: JsonEscape::new(),
                        },
                    },
                )
            }
            SourceFragment::LossyText(bytes) => (
                bytes,
                Conversion::Lossy {
                    decoder: Utf8Lossy::new(),
                    escape: JsonEscape::new(),
                },
            ),
            SourceFragment::JsonString(json)
            | SourceFragment::OwnedJsonString { source: json, .. } => {
                (json.into_bytes(), Conversion::Escape(JsonEscape::new()))
            }
            SourceFragment::Base64(bytes) => (bytes, Conversion::Base64(Base64Encoder::new())),
        };
        let input = match bytes {
            SourceBytes::Inline(bytes) => Input::Inline { bytes, offset: 0 },
            SourceBytes::Source(source) => Input::Source {
                factory: source,
                cursor: None,
            },
        };
        Self {
            owner,
            input,
            conversion,
            finished: false,
        }
    }
    pub(in crate::adapters) async fn next(
        &mut self,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Option<Bytes>> {
        if self.finished {
            return Ok(None);
        }
        if !matches!((&self.input,&self.conversion),(Input::Inline{bytes,..},Conversion::Raw)if bytes.len()<=INPUT_QUANTUM)
        {
            tokio::task::yield_now().await;
        }
        if matches!(self.conversion, Conversion::Raw) {
            match &mut self.input {
                Input::Inline { bytes, offset } => {
                    let end = (*offset + INPUT_QUANTUM).min(bytes.len());
                    let part = bytes.slice(*offset..end);
                    *offset = end;
                    self.finished = end == bytes.len();
                    return Ok(Some(part));
                }
                Input::Source { factory, cursor } => {
                    let source = cursor.get_or_insert_with(|| factory.open(budget.clone()));
                    let mut buffer = budget.allocate(INPUT_QUANTUM).await?;
                    buffer.limit(INPUT_QUANTUM);
                    let mut read = source.read_chunk(buffer).await?;
                    read.buffer = read.buffer.retain_owner(self.owner.clone());
                    if read.bytes_read == 0 && !read.eof {
                        return Err(io::Error::other("source made no progress"));
                    }
                    self.finished = read.eof;
                    return Ok(Some(read.buffer.into_bytes(read.bytes_read)));
                }
            }
        }
        if matches!(self.conversion, Conversion::Base64(_)) {
            return self.next_base64(budget).await;
        }
        // Reserve the whole transform envelope before starting an accepted read.
        let quantum = match self.conversion {
            Conversion::Lossy { .. } => 512,
            _ => INPUT_QUANTUM,
        };
        let mut input_buffer = budget.allocate(quantum).await?;
        input_buffer.limit(quantum);
        let input_len = input_buffer.as_mut().len();
        let scratch_size = if matches!(self.conversion, Conversion::Lossy { .. }) {
            input_len * 3 + 8
        } else {
            input_len + 8
        };
        let mut scratch = budget.allocate(scratch_size).await?;
        let output_size = scratch_size * 6 + 16;
        let mut output = budget.allocate(output_size).await?;
        let (input, eof) = match &mut self.input {
            Input::Inline { bytes, offset } => {
                let end = (*offset + input_len).min(bytes.len());
                let part = bytes.slice(*offset..end);
                *offset = end;
                (part, end == bytes.len())
            }
            Input::Source { factory, cursor } => {
                let source = cursor.get_or_insert_with(|| factory.open(budget.clone()));
                let read = source.read_chunk(input_buffer).await?;
                if read.bytes_read == 0 && !read.eof {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "source made no progress",
                    ));
                }
                (read.buffer.into_bytes(read.bytes_read), read.eof)
            }
        };
        let (written, finished) = match &mut self.conversion {
            Conversion::Raw => {
                self.finished = eof;
                return Ok(Some(input));
            }
            Conversion::Escape(transform) => {
                let progress = transform.transform(&input, eof, output.as_mut())?;
                require_consumed(progress.consumed, input.len())?;
                (progress.written, progress.finished)
            }
            Conversion::Base64(_) => unreachable!("dedicated media envelope"),
            Conversion::Lossy { decoder, escape } => {
                let decoded = decoder.transform(&input, eof, scratch.as_mut())?;
                require_consumed(decoded.consumed, input.len())?;
                let progress = escape.transform(
                    &scratch.as_ref()[..decoded.written],
                    decoded.finished,
                    output.as_mut(),
                )?;
                require_consumed(progress.consumed, decoded.written)?;
                (progress.written, progress.finished)
            }
            Conversion::DecodeEscape { decoder, escape } => {
                let decoded = decoder.transform(&input, eof, scratch.as_mut())?;
                require_consumed(decoded.consumed, input.len())?;
                let progress = escape.transform(
                    &scratch.as_ref()[..decoded.written],
                    decoded.finished,
                    output.as_mut(),
                )?;
                require_consumed(progress.consumed, decoded.written)?;
                (progress.written, progress.finished)
            }
        };
        self.finished = finished;
        if eof && !finished {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "truncated source transform",
            ));
        }
        output = output.retain_owner(self.owner.clone());
        Ok(Some(output.into_bytes(written)))
    }
    async fn next_base64(&mut self, budget: Arc<dyn SourceBudget>) -> io::Result<Option<Bytes>> {
        let input_buffer = if matches!(self.input, Input::Source { .. }) {
            let mut buffer = budget.allocate(BASE64_INPUT_QUANTUM).await?;
            buffer.limit(BASE64_INPUT_QUANTUM);
            Some(buffer)
        } else {
            None
        };
        let mut output = budget.allocate(BASE64_OUTPUT_QUANTUM).await?;
        output.limit(BASE64_OUTPUT_QUANTUM);
        let (input, eof) = match &mut self.input {
            Input::Inline { bytes, offset } => {
                let end = (*offset + BASE64_INPUT_QUANTUM).min(bytes.len());
                let input = bytes.slice(*offset..end);
                *offset = end;
                (input, end == bytes.len())
            }
            Input::Source { factory, cursor } => {
                // Both buffers are admitted before opening an accepted source read.
                let source = cursor.get_or_insert_with(|| factory.open(budget.clone()));
                let read = source
                    .read_chunk(input_buffer.expect("source input buffer"))
                    .await?;
                if read.bytes_read == 0 && !read.eof {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "source made no progress",
                    ));
                }
                (read.buffer.into_bytes(read.bytes_read), read.eof)
            }
        };
        let Conversion::Base64(transform) = &mut self.conversion else {
            unreachable!("media conversion")
        };
        let progress = transform.transform(&input, eof, output.as_mut())?;
        require_consumed(progress.consumed, input.len())?;
        self.finished = progress.finished;
        if eof && !self.finished {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "truncated source transform",
            ));
        }
        output = output.retain_owner(self.owner.clone());
        Ok(Some(output.into_bytes(progress.written)))
    }
}
fn require_consumed(consumed: usize, expected: usize) -> io::Result<()> {
    if consumed == expected {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "transform exceeded its reserved envelope",
        ))
    }
}

pub(in crate::adapters) async fn escaped_equals(
    text: &TextSource,
    expected: &[u8],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    let mut cursor = FragmentCursor::new(SourceFragment::Text(text.clone()));
    let mut offset = 0;
    while let Some(bytes) = cursor.next(budget.clone()).await? {
        let Some(wanted) = expected.get(offset..offset + bytes.len()) else {
            return Ok(false);
        };
        if bytes.as_ref() != wanted {
            return Ok(false);
        }
        offset += bytes.len();
    }
    Ok(offset == expected.len())
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::adapters) enum MediaKind {
    Image,
    Video,
    AudioWav,
    AudioMp3,
    AudioOther,
    Pdf,
    Text,
    Other,
}
async fn starts_with(
    text: &TextSource,
    expected: &[u8],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    let mut cursor = FragmentCursor::new(SourceFragment::Text(text.clone()));
    let mut offset = 0;
    while let Some(bytes) = cursor.next(budget.clone()).await? {
        let count = bytes.len().min(expected.len() - offset);
        if bytes[..count] != expected[offset..offset + count] {
            return Ok(false);
        }
        offset += count;
        if offset == expected.len() {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(in crate::adapters) async fn media_kind(
    text: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<MediaKind> {
    if starts_with(text, b"image/", budget.clone()).await? {
        return Ok(MediaKind::Image);
    }
    if starts_with(text, b"video/", budget.clone()).await? {
        return Ok(MediaKind::Video);
    }
    if starts_with(text, b"audio/", budget.clone()).await? {
        return Ok(
            if escaped_equals(text, b"audio/wav", budget.clone()).await? {
                MediaKind::AudioWav
            } else if escaped_equals(text, b"audio/mp3", budget.clone()).await?
                || escaped_equals(text, b"audio/mpeg", budget).await?
            {
                MediaKind::AudioMp3
            } else {
                MediaKind::AudioOther
            },
        );
    }
    if escaped_equals(text, b"application/pdf", budget.clone()).await? {
        return Ok(MediaKind::Pdf);
    }
    if starts_with(text, b"text/", budget).await? {
        return Ok(MediaKind::Text);
    }
    Ok(MediaKind::Other)
}
pub(in crate::adapters) fn quoted(text: TextSource) -> Vec<SourceFragment> {
    vec![
        SourceFragment::literal(b"\""),
        SourceFragment::Text(text),
        SourceFragment::literal(b"\""),
    ]
}

/// Apply explicit provider fields while retaining the source object's insertion order.
pub(in crate::adapters) fn chat_content_array(
    parts: Arc<
        dyn maka_agent_facts::model::prompt_source::source::RecipeSource<
                maka_agent_facts::model::prompt_source::source::ContentRecipe,
            >,
    >,
    language: maka_agent_facts::language::Language,
) -> io::Result<Vec<SourceFragment>> {
    content_array::plan(parts, content_array::Codec::Chat, language)
}
pub(in crate::adapters) fn chat_textual_array(
    parts: Arc<
        dyn maka_agent_facts::model::prompt_source::source::RecipeSource<
                maka_agent_facts::model::prompt_source::source::ContentRecipe,
            >,
    >,
    language: maka_agent_facts::language::Language,
) -> io::Result<Vec<SourceFragment>> {
    content_array::textual(parts, language)
}
pub(in crate::adapters) fn responses_content_array(
    parts: Arc<
        dyn maka_agent_facts::model::prompt_source::source::RecipeSource<
                maka_agent_facts::model::prompt_source::source::ContentRecipe,
            >,
    >,
) -> io::Result<Vec<SourceFragment>> {
    content_array::plan(
        parts,
        content_array::Codec::Responses,
        maka_agent_facts::language::Language::En,
    )
}
pub(in crate::adapters) fn content_array_allocation() -> io::Result<usize> {
    content_array::allocation()
}

pub(in crate::adapters) fn object_allocation_shape(
    arities: &[usize],
    child_owned: usize,
) -> io::Result<usize> {
    object::allocation_shape(arities, child_owned)
}
pub(in crate::adapters) async fn object_with_fields(
    source: Option<JsonSource>,
    fields: Vec<(&'static str, Vec<SourceFragment>)>,
    _budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    object::plan(source, fields, Vec::new(), false)
}
pub(in crate::adapters) async fn object_with_overlay(
    fields: Vec<(&'static str, Vec<SourceFragment>)>,
    overlay: Option<JsonSource>,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    object_with_overlay_and_final(fields, overlay, Vec::new(), budget).await
}
pub(in crate::adapters) async fn object_with_overlay_and_final(
    fields: Vec<(&'static str, Vec<SourceFragment>)>,
    overlay: Option<JsonSource>,
    finals: Vec<(&'static str, Vec<SourceFragment>)>,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<SourceFragment>> {
    let overlay = match overlay {
        Some(source)
            if maka_agent_facts::model::prompt_source::source::json::kind(&source, budget)
                .await?
                == maka_agent_facts::model::prompt_source::source::json::JsonKind::Object =>
        {
            Some(source)
        }
        _ => None,
    };
    object::plan(overlay, fields, finals, true)
}
pub(in crate::adapters) struct FragmentSequence {
    items: Arc<[SourceFragment]>,
    index: usize,
    current: Option<FragmentCursor>,
    pending: Option<Bytes>,
    offset: usize,
}
impl FragmentSequence {
    pub(in crate::adapters) fn new(items: Arc<[SourceFragment]>) -> Self {
        Self {
            items,
            index: 0,
            current: None,
            pending: None,
            offset: 0,
        }
    }
    pub(in crate::adapters) async fn copy(
        &mut self,
        out: &mut [u8],
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<(usize, bool)> {
        let mut written = 0;
        while written < out.len() {
            if let Some(bytes) = &self.pending {
                let count = (out.len() - written).min(bytes.len() - self.offset);
                out[written..written + count]
                    .copy_from_slice(&bytes[self.offset..self.offset + count]);
                written += count;
                self.offset += count;
                if self.offset < bytes.len() {
                    return Ok((written, false));
                }
                self.pending = None;
                self.offset = 0;
            }
            if let Some(current) = &mut self.current {
                if let Some(bytes) = current.next(budget.clone()).await? {
                    if !bytes.is_empty() {
                        self.pending = Some(bytes)
                    }
                    continue;
                }
                self.current = None;
            }
            let Some(fragment) = self.items.get(self.index) else {
                return Ok((written, true));
            };
            self.index += 1;
            self.current = Some(FragmentCursor::new(fragment.clone()));
        }
        Ok((written, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::{Allocate, ChargedBuffer};
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    async fn collect(fragment: SourceFragment) -> Vec<u8> {
        let mut cursor = FragmentCursor::new(fragment);
        let mut result = Vec::new();
        while let Some(bytes) = cursor.next(Arc::new(Budget)).await.expect("encode fixture") {
            assert!(bytes.len() <= 16 * 1024, "bounded provider chunk");
            result.extend_from_slice(&bytes);
        }
        result
    }
    struct Chunked {
        bytes: Bytes,
        limit: usize,
    }
    struct ChunkedCursor {
        bytes: Bytes,
        offset: usize,
        limit: usize,
    }
    impl maka_agent_facts::model::prompt_source::source::ByteSource for Chunked {
        fn len(&self) -> Option<u64> {
            Some(self.bytes.len() as u64)
        }
        fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(ChunkedCursor {
                bytes: self.bytes.clone(),
                offset: 0,
                limit: self.limit,
            })
        }
    }
    impl ByteCursor for ChunkedCursor {
        fn read_chunk(
            &mut self,
            mut buffer: ChargedBuffer,
        ) -> maka_agent_facts::model::prompt_source::source::ReadSource<'_> {
            Box::pin(async move {
                let length = (self.bytes.len() - self.offset)
                    .min(buffer.as_mut().len())
                    .min(self.limit);
                buffer.as_mut()[..length]
                    .copy_from_slice(&self.bytes[self.offset..self.offset + length]);
                self.offset += length;
                Ok(maka_agent_facts::model::prompt_source::source::SourceRead {
                    buffer,
                    bytes_read: length,
                    eof: self.offset == self.bytes.len(),
                })
            })
        }
    }
    #[tokio::test]
    async fn media_base64_short_reads_preserve_bytes_and_final_slice_custody() {
        use base64::Engine as _;
        let bytes = Bytes::from(
            (0..BASE64_INPUT_QUANTUM * 2 + 1)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let expected = base64::engine::general_purpose::STANDARD.encode(&bytes);
        for limit in [1, 2, 3137, BASE64_INPUT_QUANTUM] {
            let source = Arc::new(Chunked {
                bytes: bytes.clone(),
                limit,
            });
            let weak = Arc::downgrade(&source);
            let mut cursor =
                FragmentCursor::new(SourceFragment::Base64(SourceBytes::Source(source.clone())));
            drop(source);
            let mut result = Vec::new();
            let mut last = None;
            while let Some(chunk) = cursor.next(Arc::new(Budget)).await.expect("source media") {
                assert!(chunk.len() <= 16 * 1024);
                result.extend_from_slice(&chunk);
                last = Some(chunk);
            }
            assert_eq!(result, expected.as_bytes(), "short-read limit {limit}");
            drop(cursor);
            assert!(
                weak.upgrade().is_some(),
                "final encoded slice retains the source authority"
            );
            drop(last);
            assert!(
                weak.upgrade().is_none(),
                "final release settles source custody"
            );
        }
    }
}
