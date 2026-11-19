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

use std::{collections::BTreeMap, ops::Range};

use nsh_core::{TextSourceKind, TextSourceSegment};

use super::{CustomNode, Inline, Source};
use crate::text_view::MarkdownExtension;

pub(super) struct Anchors<'a>(BTreeMap<u64, Vec<&'a str>>);

impl<'a> Anchors<'a> {
    pub(super) fn new(extensions: &'a [MarkdownExtension]) -> Self {
        let mut anchors = BTreeMap::<_, Vec<_>>::new();
        for extension in extensions {
            if let Some(end) = extension.after_byte {
                anchors
                    .entry(u64::from(end))
                    .or_default()
                    .push(extension.name.as_ref());
            }
        }
        Self(anchors)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn take(&mut self, source: &Source, range: Range<usize>) -> Vec<(u64, Inline)> {
        let mut out = Vec::new();
        if !self.is_empty() {
            for range in source.ranges(range) {
                while let Some((&end, _)) = self.0.range(range.start + 1..=range.end).next() {
                    for name in self.0.remove(&end).expect("anchor at selected byte") {
                        out.push((end, Inline::Custom(CustomNode::new(name))));
                    }
                }
            }
        }
        out
    }
}

fn take_units<'a>(text: &mut &'a str, units: u32) -> &'a str {
    let len = nsh_core::text_edit::utf16_to_byte(text, units);
    let (part, tail) = text.split_at(len);
    *text = tail;
    part
}

fn mapped_text(text: &str, start: u64, end: u64, kind: TextSourceKind, out: &mut Vec<Inline>) {
    if !text.is_empty() {
        out.push(Inline::Source {
            content: vec![Inline::text(text)],
            segments: vec![TextSourceSegment {
                start: 0,
                end: text.encode_utf16().count() as u32,
                source_start: start,
                source_end: end,
                kind,
            }],
        });
    }
}

// Lexical replacements (entities, escapes) stay indivisible. All other
// text keeps its original selection mapping on both sides of each marker.
pub(super) fn split_text(
    mut text: &str,
    segments: Vec<TextSourceSegment>,
    markers: Vec<(u64, Inline)>,
    out: &mut Vec<Inline>,
) {
    let mut markers = markers.into_iter().peekable();
    let mut units = 0;
    for segment in segments {
        if units < segment.start {
            out.push(Inline::text(take_units(&mut text, segment.start - units)));
        }
        let mut part = take_units(&mut text, segment.end - segment.start);
        let mut start = segment.source_start;
        while let Some((_, marker)) = markers.next_if(|(end, _)| *end <= start) {
            out.push(marker);
        }
        while let Some((end, marker)) = markers.next_if(|(end, _)| *end <= segment.source_end) {
            let byte = if segment.kind == TextSourceKind::Literal {
                part.ceil_char_boundary((end.saturating_sub(start) as usize).min(part.len()))
            } else {
                part.len()
            };
            let (prefix, rest) = part.split_at(byte);
            let stop = if segment.kind == TextSourceKind::Literal {
                start + byte as u64
            } else {
                segment.source_end
            };
            mapped_text(prefix, start, stop, segment.kind, out);
            out.push(marker);
            part = rest;
            start = stop;
        }
        mapped_text(part, start, segment.source_end, segment.kind, out);
        units = segment.end;
    }
    if !text.is_empty() {
        out.push(Inline::text(text));
    }
    out.extend(markers.map(|(_, node)| node));
}
