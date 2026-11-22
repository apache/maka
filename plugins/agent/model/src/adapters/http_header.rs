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

//! Immutable HTTP envelope fields, shared by every fresh upload cursor.
use maka_capabilities::http::Bytes;
use maka_provider_protocol::json_stream::{JsonChunks, MemberBoundary};
use serde_json::Value;
use std::{ops::Range, sync::Arc};

#[derive(Clone)]
pub(super) struct Header {
    chunks: Arc<[Bytes]>,
    length: usize,
    usage: Option<Usage>,
}
#[derive(Clone)]
struct Usage {
    field: Range<usize>,
    last: Range<usize>,
}
impl Header {
    pub async fn freeze(fields: Value) -> Self {
        let mut encoder = JsonChunks::new(fields);
        let (mut current, mut selected, mut last) = (None, None, 0..0);
        let mut chunks = Vec::new();
        let mut length = 0;
        while let Some(chunk) = encoder.next_with_member_boundaries(|boundary| match boundary {
            MemberBoundary::Start { key, offset } => {
                current = Some((key == "stream_options", offset))
            }
            MemberBoundary::End { offset } => {
                let (usage, start) = current.take().expect("started header member");
                last = start..offset;
                if usage {
                    selected = Some(last.clone());
                }
            }
        }) {
            length += chunk.len();
            chunks.push(Bytes::from(chunk.into_boxed_slice()));
            tokio::task::yield_now().await;
        }
        Self {
            chunks: chunks.into(),
            length,
            usage: selected.map(|field| Usage { field, last }),
        }
    }
    pub fn has_stream_options(&self) -> bool {
        self.usage.is_some()
    }
    pub fn open(&self, key: ArrayKey) -> Prefix {
        Prefix {
            chunks: self.chunks.clone(),
            index: 0,
            suffix: Some(Bytes::from_static(match (key, self.length == 2) {
                (ArrayKey::Messages, true) => b"\"messages\":[",
                (ArrayKey::Messages, false) => b",\"messages\":[",
                (ArrayKey::System, true) => b"\"system\":[",
                (ArrayKey::System, false) => b",\"system\":[",
            })),
        }
    }
    pub async fn without_usage(&self) -> Self {
        let Some(usage) = &self.usage else {
            return self.clone();
        };
        // Match serde_json::Map::remove (swap_remove under preserve_order).
        let ranges = if usage.field == usage.last {
            let start = if usage.field.start == 1 {
                1
            } else {
                usage.field.start - 1
            };
            [0..start, usage.field.end..self.length, 0..0, 0..0]
        } else {
            [
                0..usage.field.start,
                usage.last.clone(),
                usage.field.end..usage.last.start - 1,
                usage.last.end..self.length,
            ]
        };
        let mut chunks = Vec::new();
        let mut length = 0;
        for range in ranges {
            let mut offset = 0;
            for chunk in self.chunks.iter() {
                let end = offset + chunk.len();
                let start = range.start.max(offset);
                let stop = range.end.min(end);
                if start < stop {
                    chunks.push(chunk.slice(start - offset..stop - offset));
                    length += stop - start;
                }
                offset = end;
                tokio::task::yield_now().await;
                if offset >= range.end {
                    break;
                }
            }
        }
        Self {
            chunks: chunks.into(),
            length,
            usage: None,
        }
    }
}
#[derive(Clone, Copy)]
pub(super) enum ArrayKey {
    Messages,
    System,
}
pub(super) struct Prefix {
    chunks: Arc<[Bytes]>,
    index: usize,
    suffix: Option<Bytes>,
}
impl Iterator for Prefix {
    type Item = Bytes;
    fn next(&mut self) -> Option<Self::Item> {
        while let Some(chunk) = self.chunks.get(self.index) {
            self.index += 1;
            let chunk = if self.index == self.chunks.len() {
                chunk.slice(..chunk.len() - 1)
            } else {
                chunk.clone()
            };
            if !chunk.is_empty() {
                return Some(chunk);
            }
        }
        self.suffix.take()
    }
}
