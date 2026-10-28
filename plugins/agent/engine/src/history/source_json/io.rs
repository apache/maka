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

//! Finite arena pages; no file access executes on the async caller.

use super::super::capture_arena::CaptureArena;
use super::{cancelled, invalid};
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ChargedBuffer, SourceBudget, SourceBytes,
};
use std::{io, ops::Range, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) const PAGE_BYTES: usize = 32 * 1024;
static ZERO: [u8; PAGE_BYTES] = [0; PAGE_BYTES];

pub(super) async fn position(arena: &CaptureArena) -> io::Result<u64> {
    arena.with_writer(|writer| Ok(writer.position())).await
}
pub(super) async fn append<const N: usize>(
    arena: &CaptureArena,
    bytes: [u8; N],
) -> io::Result<u64> {
    arena
        .with_writer(move |writer| Ok(writer.append_bytes(&bytes)?.start))
        .await
}
pub(super) async fn read<const N: usize>(arena: &CaptureArena, offset: u64) -> io::Result<[u8; N]> {
    arena
        .with_writer(move |writer| {
            let mut bytes = [0; N];
            writer.read_exact_at(offset, &mut bytes)?;
            Ok(bytes)
        })
        .await
}
pub(super) async fn write<const N: usize>(
    arena: &CaptureArena,
    offset: u64,
    bytes: [u8; N],
) -> io::Result<()> {
    arena
        .with_writer(move |writer| writer.write_at(offset, &bytes))
        .await
}
pub(super) async fn reserve(
    arena: &CaptureArena,
    length: u64,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    let start = position(arena).await?;
    let mut written = 0u64;
    while written < length {
        cancelled(cancel)?;
        let count = (length - written).min(PAGE_BYTES as u64) as usize;
        let expected = start.checked_add(written).ok_or_else(invalid)?;
        arena
            .with_writer(move |writer| {
                if writer.position() != expected {
                    return Err(invalid());
                }
                writer.append_bytes(&ZERO[..count])?;
                Ok(())
            })
            .await?;
        written += count as u64;
    }
    Ok(start)
}

pub(super) struct PageReader {
    cursor: Box<dyn ByteCursor>,
    buffer: Option<ChargedBuffer>,
    at: usize,
    used: usize,
    eof: bool,
}
impl PageReader {
    pub async fn new(source: SourceBytes, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        Ok(Self {
            cursor: source.open(budget.clone()),
            buffer: Some(budget.allocate(PAGE_BYTES).await?),
            at: 0,
            used: 0,
            eof: false,
        })
    }
    pub async fn read<const N: usize>(&mut self) -> io::Result<Option<[u8; N]>> {
        let mut output = [0; N];
        let mut written = 0;
        while written < N {
            if self.at == self.used {
                if self.eof {
                    if written == 0 {
                        return Ok(None);
                    }
                    return Err(invalid());
                }
                let read = self
                    .cursor
                    .read_chunk(self.buffer.take().ok_or_else(invalid)?)
                    .await?;
                if read.bytes_read > read.buffer.as_ref().len()
                    || (read.bytes_read == 0 && !read.eof)
                {
                    return Err(invalid());
                }
                self.at = 0;
                self.used = read.bytes_read;
                self.eof = read.eof;
                self.buffer = Some(read.buffer);
                continue;
            }
            let count = (N - written).min(self.used - self.at);
            output[written..written + count].copy_from_slice(
                &self.buffer.as_ref().ok_or_else(invalid)?.as_ref()[self.at..self.at + count],
            );
            self.at += count;
            written += count;
        }
        Ok(Some(output))
    }
}

pub(super) struct PageWriter {
    arena: CaptureArena,
    base: u64,
    written: u64,
    buffer: Option<ChargedBuffer>,
    used: usize,
    append: bool,
}
impl PageWriter {
    pub async fn new(
        arena: &CaptureArena,
        base: u64,
        budget: Arc<dyn SourceBudget>,
    ) -> io::Result<Self> {
        let buffer = budget.allocate(PAGE_BYTES).await?;
        if buffer.as_ref().is_empty() {
            return Err(invalid());
        }
        Ok(Self {
            arena: arena.clone(),
            base,
            written: 0,
            buffer: Some(buffer),
            used: 0,
            append: false,
        })
    }
    pub async fn append(arena: &CaptureArena, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let base = position(arena).await?;
        let mut writer = Self::new(arena, base, budget).await?;
        writer.append = true;
        Ok(writer)
    }
    pub async fn push(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut bytes = bytes;
        while !bytes.is_empty() {
            let buffer = self.buffer.as_mut().ok_or_else(invalid)?;
            if self.used == buffer.as_ref().len() {
                self.flush().await?;
                continue;
            }
            let count = bytes.len().min(buffer.as_ref().len() - self.used);
            if count == 0 {
                return Err(invalid());
            }
            buffer.as_mut()[self.used..self.used + count].copy_from_slice(&bytes[..count]);
            self.used += count;
            bytes = &bytes[count..];
        }
        Ok(())
    }
    pub async fn flush(&mut self) -> io::Result<()> {
        if self.used == 0 {
            return Ok(());
        }
        let buffer = self.buffer.take().ok_or_else(invalid)?;
        let offset = self.base.checked_add(self.written).ok_or_else(invalid)?;
        let used = self.used;
        let append = self.append;
        self.buffer = Some(
            self.arena
                .with_writer(move |writer| {
                    if append {
                        if writer.position() != offset {
                            return Err(invalid());
                        }
                        writer.append_bytes(&buffer.as_ref()[..used])?;
                    } else {
                        writer.write_at(offset, &buffer.as_ref()[..used])?;
                    }
                    Ok(buffer)
                })
                .await?,
        );
        self.written = self.written.checked_add(used as u64).ok_or_else(invalid)?;
        self.used = 0;
        Ok(())
    }
    pub async fn finish(mut self) -> io::Result<u64> {
        self.flush().await?;
        Ok(self.written)
    }
}

pub(super) fn region(start: u64, count: u64, size: usize) -> io::Result<Range<u64>> {
    Ok(start
        ..start
            .checked_add(count.checked_mul(size as u64).ok_or_else(invalid)?)
            .ok_or_else(invalid)?)
}
