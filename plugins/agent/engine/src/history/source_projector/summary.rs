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

//! Preserve provider summary boundaries by slicing encoded Unicode scalar spans.
use super::*;

mod backed;
use maka_agent_facts::model::{
    PlaintextResponses,
    prompt_source::source::{ByteCursor, ChargedBuffer},
};
struct State {
    profile: JsonSource,
    id: JsonSource,
    lengths: JsonSource,
    count: usize,
}
pub(super) struct Summary {
    pub options: Option<JsonSource>,
    pub metadata_bytes: usize,
}
async fn number(value: &JsonValue, context: &ProjectContext<'_>) -> io::Result<Option<u64>> {
    if value.kind != JsonKind::Number {
        return Ok(None);
    }
    match json::u64_value(&value.source, context.budget.clone()).await {
        Ok(value) => Ok(Some(value)),
        Err(error) if json::is_syntax_error(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
async fn state(
    options: &JsonSource,
    contract: PlaintextResponses,
    count_lengths: bool,
    context: &ProjectContext<'_>,
) -> io::Result<Option<State>> {
    let Some(state) = json::field(options, &["makaResponses"], context.budget.clone()).await?
    else {
        return Ok(None);
    };
    if state.kind != JsonKind::Object {
        return Ok(None);
    }
    let mut fields = json::fields(
        &state.source,
        &["version", "profile", "itemId", "summaryPartLengths"],
        context.budget.clone(),
    )
    .await?
    .into_iter();
    let Some(version) = fields.next().flatten() else {
        return Ok(None);
    };
    if number(&version, context).await? != Some(1) {
        return Ok(None);
    }
    let Some(profile) = fields
        .next()
        .flatten()
        .filter(|value| value.kind == JsonKind::String)
    else {
        return Ok(None);
    };
    if !json::text_eq(&profile.text()?, contract.profile(), context.budget.clone()).await? {
        return Ok(None);
    }
    let Some(id) = fields
        .next()
        .flatten()
        .filter(|value| value.kind == JsonKind::String)
    else {
        return Ok(None);
    };
    if json::text_eq(&id.text()?, "", context.budget.clone()).await? {
        return Ok(None);
    }
    let mut cursor = source_text::cursor(id.text()?, context.budget.clone());
    let mut buffer = context.budget.allocate(4096).await?;
    loop {
        let read = cursor.read_chunk(buffer).await?;
        if read.buffer.as_ref()[..read.bytes_read]
            .iter()
            .any(u8::is_ascii_control)
        {
            return Ok(None);
        }
        buffer = read.buffer;
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "summary identity source made no progress",
            ));
        }
    }
    drop(cursor);
    drop(buffer);
    let Some(lengths) = fields
        .next()
        .flatten()
        .filter(|value| value.kind == JsonKind::Array)
    else {
        return Ok(None);
    };
    let mut count = 0usize;
    if count_lengths {
        let mut cursor =
            json::ArrayCursor::open(lengths.source.clone(), context.budget.clone()).await?;
        while let Some(value) = cursor.next().await? {
            let Some(length) = number(&value, context).await? else {
                return Ok(None);
            };
            if usize::try_from(length).is_err() {
                return Ok(None);
            }
            count = count.checked_add(1).ok_or_else(invalid)?;
        }
    }
    Ok(Some(State {
        profile: profile.source,
        id: id.source,
        lengths: lengths.source,
        count,
    }))
}
struct RawText {
    cursor: Box<dyn ByteCursor>,
    buffer: Option<ChargedBuffer>,
    at: usize,
    used: usize,
    eof: bool,
    position: u64,
}
impl RawText {
    async fn new(text: &TextSource, context: &ProjectContext<'_>) -> io::Result<Self> {
        let mut value = Self {
            cursor: text.bytes().open(context.budget.clone()),
            buffer: Some(context.budget.allocate(4096).await?),
            at: 0,
            used: 0,
            eof: false,
            position: 0,
        };
        if value.byte().await? != b'"' {
            return Err(invalid());
        }
        Ok(value)
    }
    async fn byte(&mut self) -> io::Result<u8> {
        if self.at == self.used {
            if self.eof {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "summary text ended inside a scalar",
                ));
            }
            let read = self
                .cursor
                .read_chunk(
                    self.buffer
                        .take()
                        .expect("summary work buffer owned between reads"),
                )
                .await?;
            self.buffer = Some(read.buffer);
            self.used = read.bytes_read;
            self.at = 0;
            self.eof = read.eof;
            if self.used == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "summary text source made no progress",
                ));
            }
        }
        let byte = self
            .buffer
            .as_ref()
            .expect("summary work buffer restored after read")
            .as_ref()[self.at];
        self.at += 1;
        self.position = self.position.checked_add(1).ok_or_else(invalid)?;
        Ok(byte)
    }
    async fn hex(&mut self) -> io::Result<u16> {
        let mut value = 0u16;
        for _ in 0..4 {
            let byte = self.byte().await?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(invalid()),
            };
            value = (value << 4) | u16::from(digit);
        }
        Ok(value)
    }
    // Canonical quoted text is validated already; only encoded scalar boundaries are needed.
    async fn scalar(&mut self) -> io::Result<Option<usize>> {
        let byte = self.byte().await?;
        match byte {
            b'"' => Ok(None),
            b'\\' => {
                if self.byte().await? != b'u' {
                    return Ok(Some(1));
                }
                let unit = self.hex().await?;
                if (0xd800..=0xdbff).contains(&unit) {
                    if self.byte().await? != b'\\'
                        || self.byte().await? != b'u'
                        || !(0xdc00..=0xdfff).contains(&self.hex().await?)
                    {
                        return Err(invalid());
                    }
                    Ok(Some(2))
                } else {
                    Ok(Some(1))
                }
            }
            0..=0x7f => Ok(Some(1)),
            0xc2..=0xdf => {
                self.byte().await?;
                Ok(Some(1))
            }
            0xe0..=0xef => {
                self.byte().await?;
                self.byte().await?;
                Ok(Some(1))
            }
            0xf0..=0xf4 => {
                self.byte().await?;
                self.byte().await?;
                self.byte().await?;
                Ok(Some(2))
            }
            _ => Err(invalid()),
        }
    }
}
pub(super) async fn project(
    text: &TextSource,
    options: &JsonSource,
    contract: PlaintextResponses,
    build: bool,
    context: &ProjectContext<'_>,
) -> io::Result<Option<Summary>> {
    let arena_projection = build && context.internal_arena;
    let Some(state) = state(options, contract, !arena_projection, context).await? else {
        return Ok(None);
    };
    if text.encoding() != TextEncoding::JsonString {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "summary projection requires captured quoted text source",
        ));
    }
    if arena_projection {
        return backed::project(text, state, context).await;
    }
    let count = state
        .count
        .checked_mul(4)
        .and_then(|count| count.checked_add(10 - usize::from(state.count != 0)))
        .ok_or_else(invalid)?;
    let mut metadata_bytes = super::super::joined_source::metadata_bytes(count)?;
    for value in [&state.profile, &state.id, &state.lengths] {
        footprint_add(&mut metadata_bytes, raw_footprint(value.bytes())?)?;
    }
    let mut pieces = if build {
        Vec::with_capacity(count)
    } else {
        Vec::new()
    };
    if build {
        pieces.extend([
            literal(r#"{"makaResponses":{"version":1,"profile":"#).into_bytes(),
            state.profile.into_bytes(),
            literal(r#","itemId":"#).into_bytes(),
            state.id.bytes().clone(),
            literal(r#","summaryPartLengths":"#).into_bytes(),
            state.lengths.bytes().clone(),
            literal(r#"},"openResponses":{"itemId":"#).into_bytes(),
            state.id.into_bytes(),
            literal(r#","reasoningSummary":["#).into_bytes(),
        ]);
    }
    let mut lengths = json::ArrayCursor::open(state.lengths, context.budget.clone()).await?;
    let mut raw = RawText::new(text, context).await?;
    let mut first = true;
    while let Some(value) = lengths.next().await? {
        let length = number(&value, context).await?.ok_or_else(invalid)?;
        let length = usize::try_from(length).map_err(io::Error::other)?;
        let start = raw.position;
        let mut units = 0usize;
        while units < length {
            let Some(next) = raw.scalar().await? else {
                return Ok(None);
            };
            units = units.checked_add(next).ok_or_else(invalid)?;
        }
        if units != length {
            return Ok(None);
        }
        let span = text.bytes().slice(start..raw.position)?;
        footprint_add(&mut metadata_bytes, raw_footprint(&span)?)?;
        if build {
            if !first {
                pieces.push(literal(",").into_bytes());
            }
            pieces.push(literal(r#"{"type":"summary_text","text":""#).into_bytes());
            pieces.push(span);
            pieces.push(literal(r#""}"#).into_bytes());
        }
        first = false;
    }
    if raw.scalar().await?.is_some() {
        return Ok(None);
    }
    let options = if build {
        pieces.push(literal(r#"],"reasoningContent":null}}"#).into_bytes());
        Some(JsonSource::new(super::super::joined_source::join(
            pieces,
            context.directory_owner.clone(),
        )?))
    } else {
        None
    };
    Ok(Some(Summary {
        options,
        metadata_bytes,
    }))
}
