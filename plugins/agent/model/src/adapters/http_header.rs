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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn frozen_header_replays_exact_bytes_without_copying_payload() {
        for mut fields in [
            json!({}),
            json!({"model":"中文\n\"\\".repeat(8192), "tools":[{"parameters":{"enum":[null,true,1.5]}}]}),
        ] {
            let header = Header::freeze(fields.clone()).await;
            let first = header.open(ArrayKey::Messages);
            let mut replay = header.clone().open(ArrayKey::Messages);
            for chunk in first {
                let other = replay.next().expect("complete replay prefix");
                assert_eq!(chunk, other);
                assert_eq!(
                    chunk.as_ptr(),
                    other.as_ptr(),
                    "replay must share encoded payload"
                );
            }
            assert!(replay.next().is_none());
            fields["messages"] = json!([]);
            let mut actual: Vec<u8> = header.open(ArrayKey::Messages).flatten().collect();
            actual.extend_from_slice(b"]}");
            assert_eq!(actual, serde_json::to_vec(&fields).unwrap());
        }
    }

    #[tokio::test]
    async fn usage_retry_matches_original_remove_with_deep_and_escaped_fields() {
        let mut deep = json!({"number": -0.0, "escaped":"\u{0000}中文\"\\"});
        for _ in 0..256 {
            deep = Value::Array(vec![deep]);
        }
        for keys in [
            vec!["stream_options", "model", "escaped\"\\key"],
            vec!["model", "stream_options", "escaped\"\\key"],
            vec!["model", "escaped\"\\key", "stream_options"],
            vec!["stream_options"],
            vec!["model", "escaped\"\\key"],
            vec![],
        ] {
            let mut fields = serde_json::Map::new();
            for key in keys {
                fields.insert(
                    key.into(),
                    if key == "stream_options" {
                        json!({"include_usage": true})
                    } else if key == "model" {
                        json!("fixture".repeat(8192))
                    } else {
                        deep.clone()
                    },
                );
            }
            let fields = Value::Object(fields);
            let header = Header::freeze(fields.clone()).await;
            let retried = header.without_usage().await;
            let mut original = fields;
            original.as_object_mut().unwrap().remove("stream_options");
            let expected: Vec<u8> = JsonChunks::new(original).flatten().collect();
            let actual: Vec<u8> = retried
                .chunks
                .iter()
                .flat_map(|bytes| bytes.iter().copied())
                .collect();
            assert_eq!(
                actual, expected,
                "must preserve swap_remove order and nested raw bytes"
            );
            assert!(!retried.has_stream_options());
        }
    }
}
