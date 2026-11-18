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
    forced_tool_choice: Option<ForcedToolChoice>,
}
#[derive(Clone)]
struct Usage {
    field: Range<usize>,
    last: Range<usize>,
}
#[derive(Clone)]
struct ForcedToolChoice {
    field: Range<usize>,
    replacement: &'static [u8],
}
enum TrackedMember {
    Other,
    Usage,
    ToolChoice,
}
fn forced_replacement(fields: &Value) -> Option<&'static [u8]> {
    match fields.get("tool_choice")? {
        Value::String(choice) if choice == "required" => Some(b"\"tool_choice\":\"auto\""),
        Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("any") => {
            match map.get("disable_parallel_tool_use") {
                Some(Value::Bool(true)) => {
                    Some(b"\"tool_choice\":{\"type\":\"auto\",\"disable_parallel_tool_use\":true}")
                }
                Some(Value::Bool(false)) => {
                    Some(b"\"tool_choice\":{\"type\":\"auto\",\"disable_parallel_tool_use\":false}")
                }
                _ => Some(b"\"tool_choice\":{\"type\":\"auto\"}"),
            }
        }
        _ => None,
    }
}
fn shift_range(range: &Range<usize>, after: usize, delta: isize) -> Range<usize> {
    if range.start >= after {
        ((range.start as isize + delta) as usize)..((range.end as isize + delta) as usize)
    } else {
        range.clone()
    }
}
impl Header {
    pub async fn freeze(fields: Value) -> Self {
        let replacement = forced_replacement(&fields);
        let mut encoder = JsonChunks::new(fields);
        let (mut current, mut selected, mut selected_tool_choice, mut last) =
            (None, None, None, 0..0);
        let mut chunks = Vec::new();
        let mut length = 0;
        while let Some(chunk) = encoder.next_with_member_boundaries(|boundary| match boundary {
            MemberBoundary::Start { key, offset } => {
                let kind = match key {
                    "stream_options" => TrackedMember::Usage,
                    "tool_choice" => TrackedMember::ToolChoice,
                    _ => TrackedMember::Other,
                };
                current = Some((kind, offset));
            }
            MemberBoundary::End { offset } => {
                let (kind, start) = current.take().expect("started header member");
                last = start..offset;
                match kind {
                    TrackedMember::Usage => selected = Some(last.clone()),
                    TrackedMember::ToolChoice => selected_tool_choice = Some(last.clone()),
                    TrackedMember::Other => {}
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
            forced_tool_choice: replacement
                .zip(selected_tool_choice)
                .map(|(replacement, field)| ForcedToolChoice { field, replacement }),
        }
    }
    pub fn has_stream_options(&self) -> bool {
        self.usage.is_some()
    }
    pub fn has_forced_tool_choice(&self) -> bool {
        self.forced_tool_choice.is_some()
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
        let forced_tool_choice = self.forced_tool_choice.as_ref().map(|forced| {
            let field = if usage.field == usage.last || forced.field.end <= usage.field.start {
                forced.field.clone()
            } else if forced.field == usage.last {
                usage.field.start..(usage.field.start + forced.field.len())
            } else {
                let delta = usage.last.len() as isize - usage.field.len() as isize;
                shift_range(&forced.field, usage.field.end, delta)
            };
            ForcedToolChoice {
                field,
                replacement: forced.replacement,
            }
        });
        Self {
            chunks: chunks.into(),
            length,
            usage: None,
            forced_tool_choice,
        }
    }
    pub async fn without_forced_tool_choice(&self) -> Self {
        let Some(forced) = &self.forced_tool_choice else {
            return self.clone();
        };
        let mut chunks = Vec::new();
        let mut length = 0;
        for (index, range) in [0..forced.field.start, forced.field.end..self.length]
            .into_iter()
            .enumerate()
        {
            if index == 1 {
                chunks.push(Bytes::from_static(forced.replacement));
                length += forced.replacement.len();
            }
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
        let delta = forced.replacement.len() as isize - forced.field.len() as isize;
        let usage = self.usage.as_ref().map(|usage| Usage {
            field: shift_range(&usage.field, forced.field.end, delta),
            last: shift_range(&usage.last, forced.field.end, delta),
        });
        Self {
            chunks: chunks.into(),
            length,
            usage,
            forced_tool_choice: None,
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
