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

//! Stream oversized summary options into the original request arena.
use super::*;
use crate::history::{
    capture_arena,
    serialize_source::{ArenaEmit, AsyncEmit},
};

fn check_cancel(context: &ProjectContext<'_>) -> io::Result<()> {
    if context.cancellation.is_cancelled() {
        Err(crate::preparation_cancelled("summary projection cancelled"))
    } else {
        Ok(())
    }
}
async fn validate(
    text: &TextSource,
    state: &State,
    context: &ProjectContext<'_>,
) -> io::Result<bool> {
    let mut lengths =
        json::ArrayCursor::open(state.lengths.clone(), context.budget.clone()).await?;
    let mut raw = RawText::new(text, context).await?;
    while let Some(value) = lengths.next().await? {
        check_cancel(context)?;
        let Some(length) = number(&value, context).await? else {
            return Ok(false);
        };
        let Ok(length) = usize::try_from(length) else {
            return Ok(false);
        };
        let mut units = 0usize;
        while units < length {
            check_cancel(context)?;
            let Some(next) = raw.scalar().await? else {
                return Ok(false);
            };
            units = units.checked_add(next).ok_or_else(invalid)?;
        }
        if units != length {
            return Ok(false);
        }
    }
    Ok(raw.scalar().await?.is_none())
}
async fn emit(
    source: &SourceBytes,
    sink: &mut ArenaEmit,
    context: &ProjectContext<'_>,
) -> io::Result<()> {
    let mut cursor = source.open(context.budget.clone());
    let mut buffer = context.budget.allocate(4096).await?;
    loop {
        if context.cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled("summary projection cancelled"));
        }
        let read = cursor.read_chunk(buffer).await?;
        sink.write(&read.buffer.as_ref()[..read.bytes_read]).await?;
        buffer = read.buffer;
        if read.eof {
            return Ok(());
        }
        if read.bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "summary projection source made no progress",
            ));
        }
    }
}
pub(super) async fn project(
    text: &TextSource,
    state: State,
    context: &ProjectContext<'_>,
) -> io::Result<Option<Summary>> {
    if !validate(text, &state, context).await? {
        return Ok(None);
    }
    let arena = context
        .arena
        .ok_or_else(|| io::Error::other("oversized summary projection lacks its request arena"))?;
    let mut sink = ArenaEmit::new(arena.clone(), &context.budget, context.cancellation).await?;
    let start = sink.position();
    sink.write(br#"{"makaResponses":{"version":1,"profile":"#)
        .await?;
    emit(state.profile.bytes(), &mut sink, context).await?;
    sink.write(br#","itemId":"#).await?;
    emit(state.id.bytes(), &mut sink, context).await?;
    sink.write(br#","summaryPartLengths":"#).await?;
    emit(state.lengths.bytes(), &mut sink, context).await?;
    sink.write(br#"},"openResponses":{"itemId":"#).await?;
    emit(state.id.bytes(), &mut sink, context).await?;
    sink.write(br#","reasoningSummary":["#).await?;
    let mut lengths = json::ArrayCursor::open(state.lengths, context.budget.clone()).await?;
    let mut raw = RawText::new(text, context).await?;
    let mut first = true;
    while let Some(value) = lengths.next().await? {
        check_cancel(context)?;
        let length = usize::try_from(number(&value, context).await?.ok_or_else(invalid)?)
            .map_err(io::Error::other)?;
        let start = raw.position;
        let mut units = 0usize;
        while units < length {
            check_cancel(context)?;
            let next = raw.scalar().await?.ok_or_else(invalid)?;
            units = units.checked_add(next).ok_or_else(invalid)?;
        }
        if units != length {
            return Err(invalid());
        }
        if !first {
            sink.write(b",").await?;
        }
        sink.write(br#"{"type":"summary_text","text":""#).await?;
        emit(
            &text.bytes().slice(start..raw.position)?,
            &mut sink,
            context,
        )
        .await?;
        sink.write(br#""}"#).await?;
        first = false;
    }
    sink.write(br#"],"reasoningContent":null}}"#).await?;
    let end = sink.position();
    sink.finish().await?;
    Ok(Some(Summary {
        options: Some(JsonSource::new(arena.inspect(start..end))),
        metadata_bytes: capture_arena::source_metadata_bytes(1)?,
    }))
}
