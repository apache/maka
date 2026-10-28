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

//! A flat indexed directory of raw leaves and static JSON punctuation.

use super::super::capture_arena::CaptureArena;
use super::{
    Roots, arc_bytes,
    build::Compiled,
    invalid,
    record::{SEGMENT_BYTES, Segment},
};
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, ReadSource, SourceBudget, SourceBytes, SourceRead,
};
use std::{io, mem, ops::Range, sync::Arc};

pub(super) fn metadata_bytes() -> io::Result<usize> {
    arc_bytes(mem::size_of::<Directory>(), mem::align_of::<Directory>())?
        .checked_add(arc_bytes(mem::size_of::<Rope>(), mem::align_of::<Rope>())?)
        .ok_or_else(invalid)
}
pub(super) fn source(
    arena: CaptureArena,
    roots: Roots,
    compiled: Compiled,
    owner: Arc<dyn Send + Sync>,
) -> io::Result<SourceBytes> {
    let directory = Arc::new(Directory {
        arena,
        roots,
        start: compiled.directory,
        count: compiled.pieces,
        length: compiled.length,
        _owner: owner,
    });
    Ok(SourceBytes::Source(Arc::new(Rope {
        directory,
        range: 0..compiled.length,
    })))
}
struct Directory {
    arena: CaptureArena,
    roots: Roots,
    start: u64,
    count: u64,
    length: u64,
    _owner: Arc<dyn Send + Sync>,
}
impl Directory {
    async fn segment(&self, index: u64, budget: Arc<dyn SourceBudget>) -> io::Result<Segment> {
        if index >= self.count {
            return Err(invalid());
        }
        let offset = self
            .start
            .checked_add(
                index
                    .checked_mul(SEGMENT_BYTES as u64)
                    .ok_or_else(invalid)?,
            )
            .ok_or_else(invalid)?;
        let end = offset
            .checked_add(SEGMENT_BYTES as u64)
            .ok_or_else(invalid)?;
        let mut cursor = self.arena.inspect(offset..end).open(budget.clone());
        let mut buffer = budget.allocate(SEGMENT_BYTES).await?;
        let mut bytes = [0; SEGMENT_BYTES];
        let mut count = 0usize;
        while count < SEGMENT_BYTES {
            let read = cursor.read_chunk(buffer).await?;
            if read.bytes_read == 0 || read.bytes_read > SEGMENT_BYTES - count {
                return Err(invalid());
            }
            bytes[count..count + read.bytes_read]
                .copy_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            count += read.bytes_read;
            buffer = read.buffer;
            if read.eof && count != SEGMENT_BYTES {
                return Err(invalid());
            }
        }
        Segment::decode(&bytes)
    }
    async fn locate(&self, position: u64, budget: Arc<dyn SourceBudget>) -> io::Result<u64> {
        if position >= self.length {
            return Err(invalid());
        }
        let mut low = 0u64;
        let mut high = self.count;
        while low < high {
            let middle = low + (high - low) / 2;
            if self.segment(middle, budget.clone()).await?.end <= position {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        Ok(low)
    }
}
struct Rope {
    directory: Arc<Directory>,
    range: Range<u64>,
}
impl ByteSource for Rope {
    fn len(&self) -> Option<u64> {
        Some(self.range.end - self.range.start)
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        if range.start > range.end || range.end > self.range.end - self.range.start {
            return Err(invalid());
        }
        Ok(Arc::new(Self {
            directory: self.directory.clone(),
            range: self.range.start + range.start..self.range.start + range.end,
        }))
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            directory: self.directory.clone(),
            position: self.range.start,
            end: self.range.end,
            index: None,
            active: None,
            active_end: 0,
            budget,
        })
    }
}
struct Cursor {
    directory: Arc<Directory>,
    position: u64,
    end: u64,
    index: Option<u64>,
    active: Option<Box<dyn ByteCursor>>,
    active_end: u64,
    budget: Arc<dyn SourceBudget>,
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            loop {
                if self.position == self.end {
                    return Ok(SourceRead {
                        buffer: buffer.retain_owner(self.directory.clone()),
                        bytes_read: 0,
                        eof: true,
                    });
                }
                if self.index.is_none() {
                    self.index = Some(
                        self.directory
                            .locate(self.position, self.budget.clone())
                            .await?,
                    );
                }
                let index = self.index.ok_or_else(invalid)?;
                if self.active.is_none() {
                    let segment = self.directory.segment(index, self.budget.clone()).await?;
                    let length = segment
                        .source_end
                        .checked_sub(segment.start)
                        .ok_or_else(invalid)?;
                    let begin = segment.end.checked_sub(length).ok_or_else(invalid)?;
                    if self.position < begin || self.position >= segment.end {
                        return Err(invalid());
                    }
                    self.active_end = segment.end.min(self.end);
                    if segment.source == u64::MAX {
                        if length != 1 {
                            return Err(invalid());
                        }
                        if buffer.as_ref().is_empty() {
                            return Err(invalid());
                        }
                        buffer.as_mut()[0] = segment.literal;
                        self.position += 1;
                        self.index = Some(index + 1);
                        return Ok(SourceRead {
                            buffer: buffer.retain_owner(self.directory.clone()),
                            bytes_read: 1,
                            eof: self.position == self.end,
                        });
                    }

                    let start = segment
                        .start
                        .checked_add(self.position - begin)
                        .ok_or_else(invalid)?;
                    let end = segment
                        .start
                        .checked_add(self.active_end - begin)
                        .ok_or_else(invalid)?;
                    self.active = Some(
                        self.directory
                            .roots
                            .raw_bytes(segment.source, start..end)?
                            .open(self.budget.clone()),
                    );
                }
                let mut read = self
                    .active
                    .as_mut()
                    .ok_or_else(invalid)?
                    .read_chunk(buffer)
                    .await?;
                if read.bytes_read > read.buffer.as_ref().len() {
                    return Err(invalid());
                }
                self.position = self
                    .position
                    .checked_add(read.bytes_read as u64)
                    .ok_or_else(invalid)?;
                if self.position > self.active_end {
                    return Err(invalid());
                }
                if read.eof {
                    if self.position != self.active_end {
                        return Err(invalid());
                    }
                    self.active = None;
                    self.index = Some(index + 1);
                }
                if read.bytes_read != 0 {
                    read.eof = self.position == self.end;
                    read.buffer = read.buffer.retain_owner(self.directory.clone());
                    return Ok(read);
                }
                if !read.eof {
                    return Err(invalid());
                }
                buffer = read.buffer;
            }
        })
    }
}
