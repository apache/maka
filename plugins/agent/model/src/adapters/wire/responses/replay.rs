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

//! Accepted text sections share one decoded cursor and retain no part directory.
use super::{F, JsonSource, SourceBudget, SourceBytes, TextSource, recipe};
use crate::adapters::wire::source::FragmentSequence;
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, ReadSource, SourceRead, TextEncoding,
    json::{self, ArrayCursor, ObjectCursor},
};
use maka_provider_protocol::json_stream::pull::{JsonEscape, Transform};
use std::{io, sync::Arc};
pub(super) fn content(text: TextSource, parts: JsonSource) -> io::Result<F> {
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(std::alloc::Layout::new::<Content>())
        .map_err(io::Error::other)?;
    Ok(F::owned_raw(
        JsonSource {
            bytes: SourceBytes::Source(Arc::new(Content { text, parts })),
        },
        layout.pad_to_align().size(),
    ))
}
struct Content {
    text: TextSource,
    parts: JsonSource,
}
impl ByteSource for Content {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            text: recipe::text::cursor(self.text.clone(), budget.clone()),
            parts_source: Some(self.parts.clone()),
            parts: None,
            fields: None,
            fields_source: None,
            key: "text",
            first_section: true,
            first_field: true,
            injected: false,
            budget,
            phase: Phase::Section,
            active: Some(FragmentSequence::new(Arc::from([F::literal(b"[")]))),
            input: None,
            offset: 0,
            eof: false,
            remaining: 0,
            escape: JsonEscape::new(),
            utf8_remaining: 0,
        })
    }
}
#[derive(Clone, Copy)]
enum Phase {
    Section,
    Fields,
    Text,
    Validate,
    Complete,
}
struct Cursor {
    text: Box<dyn ByteCursor>,
    parts_source: Option<JsonSource>,
    parts: Option<ArrayCursor>,
    fields: Option<ObjectCursor>,
    fields_source: Option<JsonSource>,
    key: &'static str,
    first_section: bool,
    first_field: bool,
    injected: bool,
    budget: Arc<dyn SourceBudget>,
    phase: Phase,
    active: Option<FragmentSequence>,
    input: Option<Bytes>,
    offset: usize,
    eof: bool,
    remaining: u64,
    escape: JsonEscape,
    utf8_remaining: u8,
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
impl Cursor {
    fn fragments(&mut self, parts: Vec<F>) {
        self.active = Some(FragmentSequence::new(parts.into()));
    }
    async fn section(&mut self) -> io::Result<()> {
        if let Some(source) = self.parts_source.take() {
            self.parts = Some(ArrayCursor::open(source, self.budget.clone()).await?);
        }
        let Some(part) = self.parts.as_mut().expect("parts cursor").next().await? else {
            self.phase = Phase::Validate;
            return Ok(());
        };
        let values = json::fields(
            &part.source,
            &["bytes", "key", "fields"],
            self.budget.clone(),
        )
        .await?;
        let mut values = values.into_iter();
        let length = values
            .next()
            .flatten()
            .ok_or_else(|| invalid("accepted Responses length missing"))?;
        let key = values
            .next()
            .flatten()
            .ok_or_else(|| invalid("accepted Responses key missing"))?
            .text()?;
        self.key = if json::text_eq(&key, "text", self.budget.clone()).await? {
            "text"
        } else if json::text_eq(&key, "refusal", self.budget.clone()).await? {
            "refusal"
        } else {
            return Err(invalid("invalid accepted Responses content key"));
        };
        let fields = values
            .next()
            .flatten()
            .ok_or_else(|| invalid("accepted Responses content fields missing"))?;
        self.remaining = json::u64_value(&length.source, self.budget.clone()).await?;
        self.fields = Some(ObjectCursor::open(fields.source.clone(), self.budget.clone()).await?);
        self.fields_source = Some(fields.source);
        self.first_field = true;
        self.injected = false;
        self.escape = JsonEscape::new();
        let first = std::mem::replace(&mut self.first_section, false);
        self.fragments(vec![F::literal(if first { b"{" } else { b",{" })]);
        self.phase = Phase::Fields;
        Ok(())
    }
    async fn field(&mut self) -> io::Result<()> {
        let mut fragments = Vec::with_capacity(5);
        if let Some(field) = self
            .fields
            .as_mut()
            .expect("field cursor")
            .next_spans()
            .await?
        {
            let source = self.fields_source.as_ref().expect("section fields");
            let key = source.bytes.slice(field.key_range)?;
            let is_text = json::text_eq(
                &TextSource {
                    bytes: key.clone(),
                    encoding: TextEncoding::JsonString,
                },
                self.key,
                self.budget.clone(),
            )
            .await?;
            if !std::mem::replace(&mut self.first_field, false) {
                fragments.push(F::literal(b","));
            }
            fragments.push(F::Raw(JsonSource { bytes: key }));
            fragments.push(F::literal(b":"));
            if is_text {
                if self.injected {
                    return Err(invalid("duplicate accepted Responses text key"));
                }
                self.injected = true;
                self.phase = Phase::Text;
                fragments.push(F::literal(b"\""));
            } else {
                fragments.push(F::Raw(JsonSource {
                    bytes: source.bytes.slice(field.value_range)?,
                }));
            }
        } else if !self.injected {
            self.injected = true;
            if !std::mem::replace(&mut self.first_field, false) {
                fragments.push(F::literal(b","));
            }
            fragments.push(F::literal(if self.key == "text" {
                b"\"text\":\""
            } else {
                b"\"refusal\":\""
            }));
            self.phase = Phase::Text;
        } else {
            self.fields = None;
            self.fields_source = None;
            self.phase = Phase::Section;
            fragments.push(F::literal(b"}"));
        }
        self.fragments(fragments);
        Ok(())
    }
    async fn text_ready(&mut self) -> io::Result<bool> {
        if self
            .input
            .as_ref()
            .is_some_and(|bytes| self.offset < bytes.len())
        {
            return Ok(true);
        }
        self.input = None;
        self.offset = 0;
        if self.eof {
            return Ok(false);
        }
        let mut buffer = self.budget.allocate(2048).await?;
        buffer.limit(2048);
        let read = self.text.read_chunk(buffer).await?;
        self.eof = read.eof;
        if read.bytes_read == 0 && !read.eof {
            return Err(invalid("text source made no progress"));
        }
        if read.bytes_read > 0 {
            self.input = Some(read.buffer.into_bytes(read.bytes_read));
            Ok(true)
        } else {
            Ok(false)
        }
    }
    fn boundary(&self) -> io::Result<()> {
        if self.utf8_remaining == 0 {
            Ok(())
        } else {
            Err(invalid("accepted Responses text boundary splits UTF-8"))
        }
    }
    fn utf8(&mut self, bytes: &[u8]) -> io::Result<()> {
        for byte in bytes {
            if self.utf8_remaining > 0 {
                if byte & 0xc0 != 0x80 {
                    return Err(invalid("invalid source UTF-8"));
                }
                self.utf8_remaining -= 1;
            } else {
                self.utf8_remaining = match byte {
                    0..=0x7f => 0,
                    0xc2..=0xdf => 1,
                    0xe0..=0xef => 2,
                    0xf0..=0xf4 => 3,
                    _ => return Err(invalid("invalid source UTF-8")),
                };
            }
        }
        Ok(())
    }
    async fn text(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            let p = self.escape.transform(&[], true, out)?;
            if p.finished {
                self.boundary()?;
                self.phase = Phase::Fields;
                self.fragments(vec![F::literal(b"\"")]);
            }
            return Ok(p.written);
        }
        if !self.text_ready().await? {
            return Err(invalid(
                "accepted Responses text no longer matches its boundaries",
            ));
        }
        let input = self.input.as_ref().expect("ready source text");
        let count =
            (input.len() - self.offset).min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let p = self.escape.transform(
            &input[self.offset..self.offset + count],
            count as u64 == self.remaining,
            out,
        )?;
        let input = input.clone();
        self.utf8(&input[self.offset..self.offset + p.consumed])?;
        self.offset += p.consumed;
        self.remaining -= p.consumed as u64;
        if p.finished {
            self.boundary()?;
            self.phase = Phase::Fields;
            self.fragments(vec![F::literal(b"\"")]);
        }
        Ok(p.written)
    }
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let mut written = 0;
            while written < buffer.as_mut().len() {
                tokio::task::yield_now().await;
                if let Some(active) = &mut self.active {
                    let (count, done) = active
                        .copy(&mut buffer.as_mut()[written..], self.budget.clone())
                        .await?;
                    written += count;
                    if !done {
                        break;
                    }
                    self.active = None;
                }
                match self.phase {
                    Phase::Section => self.section().await?,
                    Phase::Fields => self.field().await?,
                    Phase::Text => {
                        let remaining = self.remaining;
                        let count = self.text(&mut buffer.as_mut()[written..]).await?;
                        written += count;
                        if count == 0
                            && remaining == self.remaining
                            && matches!(self.phase, Phase::Text)
                        {
                            break;
                        }
                    }
                    Phase::Validate => {
                        if self.text_ready().await? {
                            return Err(invalid(
                                "accepted Responses text no longer matches its boundaries",
                            ));
                        }
                        self.boundary()?;
                        self.fragments(vec![F::literal(b"]")]);
                        self.phase = Phase::Complete;
                    }
                    Phase::Complete => break,
                }
            }
            Ok(SourceRead {
                buffer,
                bytes_read: written,
                eof: matches!(self.phase, Phase::Complete) && self.active.is_none(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::wire::source;
    use maka_agent_facts::model::prompt_source::source::{
        Allocate, TextEncoding,
        generated::{self, GeneratedRecipes},
    };
    struct Budget;
    impl SourceBudget for Budget {
        fn allocate(&self, minimum: usize) -> Allocate<'_> {
            Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
        }
    }
    #[tokio::test]
    async fn replay_preserves_opaque_fields_and_zero_width_text_positions() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let opaque_key = format!("opaque{}", "x".repeat(12_000));
        let mut fields = serde_json::Map::new();
        fields.insert("type".into(), serde_json::json!("output_text"));
        fields.insert("text".into(), serde_json::json!("stale"));
        fields.insert(
            opaque_key.clone(),
            serde_json::json!({"nested":[1,true,null]}),
        );
        let parts = generated::json(&serde_json::json!([
            {"bytes":0,"key":"text","fields":fields.clone()},
            {"bytes":6,"key":"refusal","fields":{"type":"refusal","opaque":"kept"}}
        ]));
        let fragment = content(generated::text("🙂\n\""), parts).expect("plan");
        let mut cursor = source::FragmentCursor::new(fragment);
        let mut bytes = Vec::new();
        while let Some(chunk) = cursor.next(budget.clone()).await.expect("replay") {
            bytes.extend_from_slice(&chunk);
        }
        fields.insert("text".into(), serde_json::json!(""));
        let expected =
            serde_json::json!([fields,{"type":"refusal","opaque":"kept","refusal":"🙂\n\""}]);
        assert_eq!(bytes, serde_json::to_vec(&expected).expect("golden"));
    }
    #[tokio::test]
    async fn one_pass_replay_splits_a_delta_concat_without_indexed_slice_support() {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let text = recipe::text::concat(
            Arc::new(GeneratedRecipes::new(vec![
                generated::text("First "),
                TextSource {
                    bytes: SourceBytes::Inline(Bytes::from_static(b"\"\\ud83d\\ude42\"")),
                    encoding: TextEncoding::JsonString,
                },
                generated::text("第二\n"),
            ])),
            budget.clone(),
        );
        let value = content(
            text,
            generated::json(&serde_json::json!([
                {"bytes":10,"key":"text","fields":{"type":"output_text"}},
                {"bytes":7,"key":"text","fields":{"type":"output_text"}}
            ])),
        );
        let mut cursor = source::FragmentCursor::new(value.expect("accepted replay plan"));
        let mut bytes = Vec::new();
        while let Some(chunk) = cursor
            .next(budget.clone())
            .await
            .expect("accepted text replay")
        {
            bytes.extend_from_slice(&chunk);
        }
        assert_eq!(bytes,serde_json::to_vec(&serde_json::json!([{"type":"output_text","text":"First 🙂"},{"type":"output_text","text":"第二\n"}])).expect("golden JSON"));
    }
}
