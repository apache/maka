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

//! Freeze canonical delta string spans into one indexed quoted text value.
use maka_agent_facts::model::prompt_source::source::{
    JsonSource, SourceBudget, SourceBytes, TextEncoding, TextSource, json,
};
use maka_event_log::context::semantic::{CapturedSource, PayloadSource};
use std::{io, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Canonical delta strings share one serializer, so their quoted contents may be
/// joined directly while retaining native ranges for later JSON field scans.
pub(super) async fn quoted(
    captured: &CapturedSource,
    payload: &PayloadSource,
    budget: Arc<dyn SourceBudget>,
    owner: Arc<dyn Send + Sync>,
    cancellation: &CancellationToken,
) -> io::Result<TextSource> {
    let mut count = 2usize;
    let mut previous = None;
    while let Some((key, _)) = captured
        .next_text_fragment(payload, previous)
        .await
        .map_err(io::Error::other)?
    {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "text capture cancelled",
            ));
        }
        count = count
            .checked_add(1)
            .ok_or_else(|| io::Error::other("text fragment count overflows"))?;
        previous = Some(key);
    }
    let mut parts = Vec::with_capacity(count);
    parts.push(SourceBytes::Inline((&b"\""[..]).into()));
    let mut after = None;
    while let Some((key, fragment)) = captured
        .next_text_fragment(payload, after)
        .await
        .map_err(io::Error::other)?
    {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "text capture cancelled",
            ));
        }
        after = Some(key);
        let json = JsonSource {
            bytes: SourceBytes::Source(captured.byte_source(&fragment).map_err(io::Error::other)?),
        };
        let token = json::field(&json, &["TextDelta", "text"], budget.clone())
            .await?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "text fragment lacks its text field",
                )
            })?
            .text()?;
        let length = token.bytes.len().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "canonical text token has no encoded length",
            )
        })?;
        if token.encoding != TextEncoding::JsonString || length < 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "canonical text fragment lacks a quoted token",
            ));
        }
        parts.push(token.bytes.slice(1..length - 1)?);
    }
    parts.push(SourceBytes::Inline((&b"\""[..]).into()));
    Ok(TextSource {
        bytes: super::joined_source::join(parts, owner)?,
        encoding: TextEncoding::JsonString,
    })
}

/// The giant directory consumes a continuous quoted token instead of retaining
/// one source adapter for every historical delta.
pub(super) async fn quoted_backed(
    captured: &CapturedSource,
    payload: &PayloadSource,
    arena: &super::capture_arena::CaptureArena,
    budget: Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> io::Result<TextSource> {
    let append = arena.begin_append().await;
    let start = append
        .with_writer(|writer| Ok(writer.append_bytes(b"\"")?.start))
        .await?;
    let mut after = None;
    while let Some((key, fragment)) = captured
        .next_text_fragment(payload, after)
        .await
        .map_err(io::Error::other)?
    {
        if cancellation.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "text capture cancelled",
            ));
        }
        after = Some(key);
        let source = JsonSource {
            bytes: SourceBytes::Source(captured.byte_source(&fragment).map_err(io::Error::other)?),
        };
        let text = json::field(&source, &["TextDelta", "text"], budget.clone())
            .await?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "text fragment lacks its text field",
                )
            })?
            .text()?;
        let length = text
            .bytes
            .len()
            .filter(|length| *length >= 2)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "text fragment lacks a quoted token",
                )
            })?;
        append_raw(
            &append,
            text.bytes.slice(1..length - 1)?,
            budget.clone(),
            cancellation,
        )
        .await?;
    }
    let end = append
        .with_writer(|writer| Ok(writer.append_bytes(b"\"")?.end))
        .await?;
    drop(append);

    Ok(TextSource {
        bytes: arena.inspect(start..end),
        encoding: TextEncoding::JsonString,
    })
}

async fn append_raw(
    append: &super::capture_arena::ArenaAppend,
    source: SourceBytes,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<()> {
    use std::io::Write;
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await?;
    loop {
        if cancel.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "text capture cancelled",
            ));
        }
        let read = cursor.read_chunk(buffer).await?;
        let used = read.bytes_read;
        let eof = read.eof;
        if used == 0 && !eof {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "text token made no progress",
            ));
        }
        buffer = append
            .with_writer(move |writer| {
                writer.write_all(&read.buffer.as_ref()[..used])?;
                Ok(read.buffer)
            })
            .await?;
        if eof {
            return Ok(());
        }
    }
}
