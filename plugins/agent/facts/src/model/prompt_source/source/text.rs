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

//! Decoded text composition without materializing logical strings.
use super::*;
use maka_provider_protocol::json_stream::pull::{
    JsonEscape, JsonStringDecoder, Progress, Transform,
};

fn arc_metadata_bytes<T>() -> io::Result<usize> {
    let header = std::mem::size_of::<usize>() * 2;
    let alignment = std::mem::align_of::<T>();
    let body_offset = header
        .checked_add(alignment - 1)
        .map(|offset| offset & !(alignment - 1))
        .ok_or_else(|| io::Error::other("source adapter layout overflows"))?;
    let allocation_alignment = alignment.max(std::mem::align_of::<usize>());
    body_offset
        .checked_add(std::mem::size_of::<T>())
        .and_then(|size| size.checked_add(allocation_alignment - 1))
        .map(|size| size & !(allocation_alignment - 1))
        .ok_or_else(|| io::Error::other("source adapter layout overflows"))
}

/// The retained concatenation adapter; its external parts directory is charged separately.
pub fn concat_metadata_bytes() -> io::Result<usize> {
    arc_metadata_bytes::<Concat>()
}

/// A replacement/encoding adapter, plus its decoder adapter for quoted input.
pub fn transform_metadata_bytes(encoding: TextEncoding) -> io::Result<usize> {
    let one = arc_metadata_bytes::<Transformed>()?;
    one.checked_mul(match encoding {
        TextEncoding::Utf8 => 1,
        TextEncoding::JsonString => 2,
    })
    .ok_or_else(|| io::Error::other("source transform layout overflows"))
}

pub fn cursor(text: TextSource, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
    match text.encoding {
        TextEncoding::Utf8 => text.bytes.open(budget),
        TextEncoding::JsonString => transformed(text.bytes, Kind::Decode, budget.clone())
            .bytes
            .open(budget),
    }
}
pub fn bytes(text: TextSource, budget: Arc<dyn SourceBudget>) -> SourceBytes {
    match text.encoding {
        TextEncoding::Utf8 => text.bytes,
        TextEncoding::JsonString => transformed(text.bytes, Kind::Decode, budget).bytes,
    }
}
pub fn concat(
    parts: Arc<dyn RecipeSource<TextSource>>,
    _budget: Arc<dyn SourceBudget>,
) -> TextSource {
    TextSource {
        bytes: SourceBytes::Source(Arc::new(Concat { parts })),
        encoding: TextEncoding::Utf8,
    }
}
pub fn replace_ascii(
    text: TextSource,
    replacements: &'static [(u8, &'static [u8])],
    budget: Arc<dyn SourceBudget>,
) -> TextSource {
    transformed(
        bytes(text, budget.clone()),
        Kind::Replace(replacements),
        budget,
    )
}
pub fn html(text: TextSource, budget: Arc<dyn SourceBudget>) -> TextSource {
    replace_ascii(
        text,
        &[(b'<', b"\\u003c"), (b'>', b"\\u003e"), (b'&', b"\\u0026")],
        budget,
    )
}
pub fn quote_label(text: TextSource, budget: Arc<dyn SourceBudget>) -> TextSource {
    replace_ascii(text, &[(b'"', b"'")], budget)
}
/// The result is UTF-8 containing an entire quoted JSON string token.
pub fn json_string(text: TextSource, budget: Arc<dyn SourceBudget>) -> TextSource {
    transformed(bytes(text, budget.clone()), Kind::Encode, budget)
}
#[derive(Clone, Copy)]
enum Kind {
    Decode,
    Encode,
    Replace(&'static [(u8, &'static [u8])]),
}
fn transformed(source: SourceBytes, kind: Kind, _budget: Arc<dyn SourceBudget>) -> TextSource {
    TextSource {
        bytes: SourceBytes::Source(Arc::new(Transformed { source, kind })),
        encoding: TextEncoding::Utf8,
    }
}
struct Transformed {
    source: SourceBytes,
    kind: Kind,
}
impl ByteSource for Transformed {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(TransformedCursor {
            source: self.source.open(budget.clone()),
            owner: self.source.clone(),
            budget,
            transform: match self.kind {
                Kind::Decode => StreamTransform::Decode(JsonStringDecoder::new()),
                Kind::Encode => StreamTransform::Encode(Quoted::default()),
                Kind::Replace(table) => StreamTransform::Replace(Replace {
                    table,
                    pending: &[],
                    offset: 0,
                }),
            },
            input: None,
            input_used: 0,
            input_read: 0,
            input_eof: false,
            finished: false,
        })
    }
}
struct TransformedCursor {
    source: Box<dyn ByteCursor>,
    owner: SourceBytes,
    budget: Arc<dyn SourceBudget>,
    transform: StreamTransform,
    input: Option<ChargedBuffer>,
    input_used: usize,
    input_read: usize,
    input_eof: bool,
    finished: bool,
}
impl ByteCursor for TransformedCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            if self.finished {
                return Ok(SourceRead {
                    buffer,
                    bytes_read: 0,
                    eof: true,
                });
            }
            let capacity = buffer.as_mut().len();
            if capacity == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "empty text work buffer",
                ));
            }
            let mut written = 0;
            loop {
                if self.input_used == self.input_read && !self.input_eof {
                    let mut input = match self.input.take() {
                        Some(input) => input,
                        None => self.budget.allocate(capacity).await?,
                    };
                    input.limit(capacity);
                    let read = self.source.read_chunk(input).await?;
                    if read.bytes_read == 0 && !read.eof {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "text source made no progress",
                        ));
                    }
                    self.input = Some(read.buffer);
                    self.input_read = read.bytes_read;
                    self.input_used = 0;
                    self.input_eof = read.eof;
                }
                let input = self
                    .input
                    .as_ref()
                    .map_or(&[][..], |b| &b.as_ref()[self.input_used..self.input_read]);
                let progress = self.transform.transform(
                    input,
                    self.input_eof,
                    &mut buffer.as_mut()[written..],
                )?;
                self.input_used += progress.consumed;
                written += progress.written;
                self.finished = progress.finished;
                if self.finished || written == capacity {
                    break;
                }
                if progress.consumed == 0
                    && progress.written == 0
                    && self.input_used < self.input_read
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "text transform made no progress",
                    ));
                }
            }
            if self.finished {
                self.input = None;
            }
            Ok(SourceRead {
                buffer: buffer.retain_owner(self.owner.clone()),
                bytes_read: written,
                eof: self.finished,
            })
        })
    }
}
enum StreamTransform {
    Decode(JsonStringDecoder),
    Encode(Quoted),
    Replace(Replace),
}
impl Transform for StreamTransform {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        match self {
            Self::Decode(t) => t.transform(input, eof, output),
            Self::Encode(t) => t.transform(input, eof, output),
            Self::Replace(t) => t.transform(input, eof, output),
        }
    }
}
#[derive(Default)]
struct Quoted {
    opened: bool,
    closed: bool,
    escape: JsonEscape,
}
impl Transform for Quoted {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        if output.is_empty() {
            return Ok(Progress {
                finished: self.closed,
                ..Default::default()
            });
        }
        let start = usize::from(!self.opened);
        if !self.opened {
            output[0] = b'"';
            self.opened = true;
        }
        if self.closed {
            return Ok(Progress {
                finished: true,
                ..Default::default()
            });
        }
        let mut p = self.escape.transform(input, eof, &mut output[start..])?;
        p.written += start;
        if p.finished {
            if p.written < output.len() {
                output[p.written] = b'"';
                p.written += 1;
                self.closed = true;
            } else {
                p.finished = false;
            }
        }
        Ok(p)
    }
}
struct Replace {
    table: &'static [(u8, &'static [u8])],
    pending: &'static [u8],
    offset: usize,
}
impl Transform for Replace {
    fn transform(&mut self, input: &[u8], eof: bool, output: &mut [u8]) -> io::Result<Progress> {
        let mut p = Progress::default();
        loop {
            let count = (self.pending.len() - self.offset).min(output.len() - p.written);
            output[p.written..p.written + count]
                .copy_from_slice(&self.pending[self.offset..self.offset + count]);
            self.offset += count;
            p.written += count;
            if self.offset < self.pending.len() || p.written == output.len() {
                break;
            }
            let Some(&b) = input.get(p.consumed) else {
                break;
            };
            p.consumed += 1;
            if let Some((_, replacement)) = self.table.iter().find(|(from, _)| *from == b) {
                self.pending = replacement;
                self.offset = 0;
            } else {
                output[p.written] = b;
                p.written += 1;
            }
        }
        p.finished = eof && p.consumed == input.len() && self.offset == self.pending.len();
        Ok(p)
    }
}
struct Concat {
    parts: Arc<dyn RecipeSource<TextSource>>,
}
impl ByteSource for Concat {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(ConcatCursor {
            parts: self.parts.open(0),
            owner: self.parts.clone(),
            budget,
            current: None,
            ended: false,
        })
    }
}
struct ConcatCursor {
    parts: Box<dyn RecipeCursor<TextSource>>,
    owner: Arc<dyn RecipeSource<TextSource>>,
    budget: Arc<dyn SourceBudget>,
    current: Option<Box<dyn ByteCursor>>,
    ended: bool,
}
impl ByteCursor for ConcatCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            loop {
                if self.ended {
                    return Ok(SourceRead {
                        buffer,
                        bytes_read: 0,
                        eof: true,
                    });
                }
                if self.current.is_none() {
                    match self.parts.next().await? {
                        Some(text) => self.current = Some(cursor(text, self.budget.clone())),
                        None => {
                            self.ended = true;
                            continue;
                        }
                    }
                }
                let mut read = self
                    .current
                    .as_mut()
                    .expect("active text part")
                    .read_chunk(buffer)
                    .await?;
                let part_eof = read.eof;
                if part_eof {
                    match self.parts.next().await? {
                        Some(text) => self.current = Some(cursor(text, self.budget.clone())),
                        None => {
                            self.current = None;
                            self.ended = true;
                        }
                    }
                }
                if read.bytes_read != 0 {
                    read.eof = self.ended;
                    read.buffer = read.buffer.retain_owner(self.owner.clone());
                    return Ok(read);
                }
                if !part_eof {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "text part made no progress",
                    ));
                }
                buffer = read.buffer;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    fn ready<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("inline source unexpectedly suspended"),
        }
    }
    fn collect(text: TextSource) -> Vec<u8> {
        let mut cursor = cursor(text, Arc::new(Budget));
        let mut result = Vec::new();
        loop {
            let read = ready(cursor.read_chunk(ChargedBuffer::new(vec![0; 1], ()))).unwrap();
            result.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            if read.eof {
                return result;
            }
        }
    }
    #[test]
    fn composed_text_replays_split_unicode_and_escaped_json() {
        let text = TextSource {
            bytes: SourceBytes::Inline(Bytes::from_static(br#""\uD83D\uDE42<\"&""#)),
            encoding: TextEncoding::JsonString,
        };
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let parts = Arc::new(super::super::generated::GeneratedRecipes::new(vec![
            super::super::generated::text("prefix "),
            text.clone(),
        ]));
        let source = json_string(html(concat(parts, budget.clone()), budget.clone()), budget);
        let expected = serde_json::to_vec("prefix 🙂\\u003c\"\\u0026").unwrap();
        assert_eq!(collect(source.clone()), expected);
        assert_eq!(
            collect(source),
            expected,
            "a fresh cursor replays the immutable recipe"
        );
    }
}
