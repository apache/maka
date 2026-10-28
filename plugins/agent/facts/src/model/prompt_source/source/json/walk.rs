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

//! One lexical traversal for request-local structural directories.

use super::{ChargedBuffer, JsonKind, JsonSource, Reader, SourceBudget, invalid, syntax};
use std::{io, ops::Range, sync::Arc};

const FRAME_BYTES: usize = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonStructureValue {
    pub ordinal: u64,
    pub parent: Option<u64>,
    pub member: u64,
    pub key_range: Option<Range<u64>>,
    pub kind: JsonKind,
    pub start: u64,
    pub end: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JsonStructureEvent {
    Value(JsonStructureValue),
    End { ordinal: u64, end: u64 },
}
#[derive(Clone, Copy)]
struct Frame {
    state: u8,
    ordinal: u64,
    member: u64,
}

pub struct StructureCursor {
    reader: Reader,
    stack: ChargedBuffer,
    depth: usize,
    next_ordinal: u64,
    started: bool,
    done: bool,
}
impl StructureCursor {
    pub async fn open(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let reader = Reader::new(source.bytes, budget.clone()).await?;
        let stack = budget
            .allocate(super::INITIAL_NESTING_BYTES * FRAME_BYTES)
            .await?;
        if stack.as_ref().len() < FRAME_BYTES {
            return Err(invalid("JSON walk allocation is too small"));
        }
        Ok(Self {
            reader,
            stack,
            depth: 0,
            next_ordinal: 0,
            started: false,
            done: false,
        })
    }
    fn frame(&self) -> Frame {
        let bytes = &self.stack.as_ref()[(self.depth - 1) * FRAME_BYTES..self.depth * FRAME_BYTES];
        Frame {
            state: bytes[0],
            ordinal: read(bytes, 8),
            member: read(bytes, 16),
        }
    }
    fn set_frame(&mut self, frame: Frame) {
        let bytes =
            &mut self.stack.as_mut()[(self.depth - 1) * FRAME_BYTES..self.depth * FRAME_BYTES];
        bytes[0] = frame.state;
        bytes[8..16].copy_from_slice(&frame.ordinal.to_le_bytes());
        bytes[16..24].copy_from_slice(&frame.member.to_le_bytes());
    }
    async fn value(
        &mut self,
        parent: Option<u64>,
        member: u64,
        key_range: Option<Range<u64>>,
    ) -> io::Result<JsonStructureEvent> {
        self.reader.whitespace().await?;
        let start = self.reader.position;
        let (kind, state) = self.reader.begin_value().await?;
        let ordinal = self.next_ordinal;
        self.next_ordinal = self
            .next_ordinal
            .checked_add(1)
            .ok_or_else(|| invalid("JSON walk ordinal overflow"))?;
        if let Some(state) = state {
            let needed = self
                .depth
                .checked_add(1)
                .and_then(|depth| depth.checked_mul(FRAME_BYTES))
                .ok_or_else(|| invalid("JSON walk depth overflow"))?;
            if needed > self.stack.as_ref().len() {
                let capacity = self
                    .stack
                    .as_ref()
                    .len()
                    .checked_mul(2)
                    .filter(|capacity| *capacity >= needed)
                    .ok_or_else(|| invalid("JSON walk allocation overflow"))?;
                let mut grown = self.reader.budget.allocate(capacity).await?;
                if grown.as_ref().len() < capacity {
                    return Err(invalid("JSON walk allocation is too small"));
                }
                grown.as_mut()[..self.depth * FRAME_BYTES]
                    .copy_from_slice(&self.stack.as_ref()[..self.depth * FRAME_BYTES]);
                self.stack = grown;
            }
            self.depth += 1;
            self.set_frame(Frame {
                state,
                ordinal,
                member: 0,
            });
        }
        Ok(JsonStructureEvent::Value(JsonStructureValue {
            ordinal,
            parent,
            member,
            key_range,
            kind,
            start,
            end: state.is_none().then_some(self.reader.position),
        }))
    }
    pub async fn next(&mut self) -> io::Result<Option<JsonStructureEvent>> {
        if self.done {
            return Ok(None);
        }
        if !self.started {
            self.started = true;
            return self.value(None, 0, None).await.map(Some);
        }
        loop {
            if self.depth == 0 {
                self.reader.end().await?;
                self.done = true;
                return Ok(None);
            }
            self.reader.whitespace().await?;
            let mut frame = self.frame();
            match frame.state {
                0 | 1 => {
                    if frame.state == 0 && self.reader.peek().await? == Some(b'}') {
                        self.reader.take().await?;
                        self.depth -= 1;
                        return Ok(Some(JsonStructureEvent::End {
                            ordinal: frame.ordinal,
                            end: self.reader.position,
                        }));
                    }
                    let key_start = self.reader.position;
                    self.reader.string().await?;
                    let key_end = self.reader.position;
                    self.reader.whitespace().await?;
                    self.reader.expect(b':').await?;
                    let member = frame.member;
                    frame.member = frame
                        .member
                        .checked_add(1)
                        .ok_or_else(|| invalid("JSON walk member overflow"))?;
                    frame.state = 4;
                    self.set_frame(frame);
                    return self
                        .value(Some(frame.ordinal), member, Some(key_start..key_end))
                        .await
                        .map(Some);
                }
                4 => match self.reader.byte().await? {
                    b'}' => {
                        self.depth -= 1;
                        return Ok(Some(JsonStructureEvent::End {
                            ordinal: frame.ordinal,
                            end: self.reader.position,
                        }));
                    }
                    b',' => {
                        frame.state = 1;
                        self.set_frame(frame);
                    }
                    _ => return Err(syntax("invalid JSON object separator")),
                },
                5 | 6 => {
                    if frame.state == 5 && self.reader.peek().await? == Some(b']') {
                        self.reader.take().await?;
                        self.depth -= 1;
                        return Ok(Some(JsonStructureEvent::End {
                            ordinal: frame.ordinal,
                            end: self.reader.position,
                        }));
                    }
                    let member = frame.member;
                    frame.member = frame
                        .member
                        .checked_add(1)
                        .ok_or_else(|| invalid("JSON walk member overflow"))?;
                    frame.state = 7;
                    self.set_frame(frame);
                    return self
                        .value(Some(frame.ordinal), member, None)
                        .await
                        .map(Some);
                }
                7 => match self.reader.byte().await? {
                    b']' => {
                        self.depth -= 1;
                        return Ok(Some(JsonStructureEvent::End {
                            ordinal: frame.ordinal,
                            end: self.reader.position,
                        }));
                    }
                    b',' => {
                        frame.state = 6;
                        self.set_frame(frame);
                    }
                    _ => return Err(syntax("invalid JSON array separator")),
                },
                _ => unreachable!("JSON walk states are internal"),
            }
        }
    }
}
fn read(bytes: &[u8], offset: usize) -> u64 {
    let mut value = [0; 8];
    value.copy_from_slice(&bytes[offset..offset + 8]);
    u64::from_le_bytes(value)
}
