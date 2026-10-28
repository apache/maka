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

//! Fixed records in the original request arena; all source IDs index its roots.

use maka_agent_facts::model::prompt_source::source::json::JsonKind;
use std::{io, ops::Range};

pub(super) const SPAN_BYTES: usize = 40;
pub(super) const FIELD_BYTES: usize = 160;
pub(super) const SEGMENT_BYTES: usize = 40;

#[derive(Clone, Copy, Debug)]
pub(super) struct Span {
    pub source: u64,
    pub start: u64,
    pub end: u64,
    pub kind: JsonKind,
    pub node: u64,
}
impl Span {
    pub fn range(self) -> Range<u64> {
        self.start..self.end
    }
    pub fn encode(self) -> [u8; SPAN_BYTES] {
        let mut bytes = [0; SPAN_BYTES];
        put(&mut bytes, 0, self.source);
        put(&mut bytes, 8, self.start);
        put(&mut bytes, 16, self.end);
        bytes[24] = kind(self.kind);
        put(&mut bytes, 32, self.node);
        bytes
    }
    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != SPAN_BYTES {
            return Err(invalid());
        }
        let span = Self {
            source: get(bytes, 0),
            start: get(bytes, 8),
            end: get(bytes, 16),
            kind: decode_kind(bytes[24])?,
            node: get(bytes, 32),
        };
        if span.start > span.end {
            return Err(invalid());
        }
        Ok(span)
    }
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Field {
    pub digest: [u8; 32],
    pub key: Span,
    pub value: Span,
    pub layer: u64,
    pub member: u64,
    pub first_layer: u64,
    pub first_member: u64,
    pub children_start: u64,
    pub children_count: u64,
}
impl Field {
    pub fn encode(self) -> [u8; FIELD_BYTES] {
        let mut bytes = [0; FIELD_BYTES];
        bytes[..32].copy_from_slice(&self.digest);
        bytes[32..72].copy_from_slice(&self.key.encode());
        bytes[72..112].copy_from_slice(&self.value.encode());
        for (index, value) in [
            self.layer,
            self.member,
            self.first_layer,
            self.first_member,
            self.children_start,
            self.children_count,
        ]
        .into_iter()
        .enumerate()
        {
            put(&mut bytes, 112 + index * 8, value);
        }
        bytes
    }
    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != FIELD_BYTES {
            return Err(invalid());
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[..32]);
        Ok(Self {
            digest,
            key: Span::decode(&bytes[32..72])?,
            value: Span::decode(&bytes[72..112])?,
            layer: get(bytes, 112),
            member: get(bytes, 120),
            first_layer: get(bytes, 128),
            first_member: get(bytes, 136),
            children_start: get(bytes, 144),
            children_count: get(bytes, 152),
        })
    }
}
pub(super) const NODE_BYTES: usize = 128;
#[derive(Clone, Copy, Debug)]
pub(super) struct Node {
    pub value: Span,
    pub key: Span,
    pub last: u64,
    pub member: u64,
    pub digest: [u8; 32],
}
impl Node {
    pub fn encode(self) -> [u8; NODE_BYTES] {
        let mut bytes = [0; NODE_BYTES];
        bytes[..40].copy_from_slice(&self.value.encode());
        bytes[40..80].copy_from_slice(&self.key.encode());
        put(&mut bytes, 80, self.last);
        put(&mut bytes, 88, self.member);
        bytes[96..128].copy_from_slice(&self.digest);
        bytes
    }
    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != NODE_BYTES {
            return Err(invalid());
        }
        let mut digest = [0; 32];
        digest.copy_from_slice(&bytes[96..128]);
        Ok(Self {
            value: Span::decode(&bytes[..40])?,
            key: Span::decode(&bytes[40..80])?,
            last: get(bytes, 80),
            member: get(bytes, 88),
            digest,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Segment {
    pub end: u64,
    pub source: u64,
    pub start: u64,
    pub source_end: u64,
    pub literal: u8,
}
impl Segment {
    pub fn encode(self) -> [u8; SEGMENT_BYTES] {
        let mut bytes = [0; SEGMENT_BYTES];
        put(&mut bytes, 0, self.end);
        put(&mut bytes, 8, self.source);
        put(&mut bytes, 16, self.start);
        put(&mut bytes, 24, self.source_end);
        bytes[32] = self.literal;
        bytes
    }
    pub fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != SEGMENT_BYTES {
            return Err(invalid());
        }
        Ok(Self {
            end: get(bytes, 0),
            source: get(bytes, 8),
            start: get(bytes, 16),
            source_end: get(bytes, 24),
            literal: bytes[32],
        })
    }
}
fn put(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
fn get(bytes: &[u8], offset: usize) -> u64 {
    let mut value = [0; 8];
    value.copy_from_slice(&bytes[offset..offset + 8]);
    u64::from_le_bytes(value)
}
fn kind(kind: JsonKind) -> u8 {
    match kind {
        JsonKind::Object => 0,
        JsonKind::Array => 1,
        JsonKind::String => 2,
        JsonKind::Number => 3,
        JsonKind::Bool => 4,
        JsonKind::Null => 5,
    }
}
fn decode_kind(kind: u8) -> io::Result<JsonKind> {
    match kind {
        0 => Ok(JsonKind::Object),
        1 => Ok(JsonKind::Array),
        2 => Ok(JsonKind::String),
        3 => Ok(JsonKind::Number),
        4 => Ok(JsonKind::Bool),
        5 => Ok(JsonKind::Null),
        _ => Err(invalid()),
    }
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid request JSON directory record",
    )
}
