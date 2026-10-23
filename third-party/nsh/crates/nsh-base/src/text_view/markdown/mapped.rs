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

//! Byte provenance through lexical rewrites. Generated syntax has no address.
use nsh_core::{TextSourceKind, TextSourceSegment};
use std::ops::{Deref, Range};

#[derive(Clone, Debug)]
struct Piece {
    rendered: Range<usize>,
    original: Range<usize>,
    literal: bool,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Source {
    text: String,
    pieces: Vec<Piece>,
}
impl Deref for Source {
    type Target = str;
    fn deref(&self) -> &str {
        &self.text
    }
}
impl Source {
    pub(super) fn original(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            pieces: if text.is_empty() {
                vec![]
            } else {
                vec![Piece {
                    rendered: 0..text.len(),
                    original: 0..text.len(),
                    literal: true,
                }]
            },
        }
    }
    pub(super) fn writer(&self) -> Writer<'_> {
        Writer {
            input: self,
            out: Self::default(),
        }
    }
    pub(super) fn slice(&self, range: Range<usize>) -> Self {
        let mut out = self.writer();
        out.copy(&self[range]);
        out.finish()
    }
    pub(super) fn push(&mut self, text: &str) {
        self.text.push_str(text);
    }
    pub(super) fn truncate(&mut self, at: usize) {
        self.text.truncate(at);
        self.pieces.retain(|p| p.rendered.start < at);
        if let Some(p) = self.pieces.last_mut()
            && p.rendered.end > at
        {
            if p.literal {
                p.original.end -= p.rendered.end - at;
            }
            p.rendered.end = at;
        }
    }
    pub(super) fn append(&mut self, source: &Self) {
        let offset = self.text.len();
        self.text.push_str(source);
        self.pieces
            .extend(source.pieces.iter().cloned().map(|mut p| {
                p.rendered.start += offset;
                p.rendered.end += offset;
                p
            }));
    }
    pub(super) fn normalize(self) -> Self {
        if !self.contains('\r') {
            return self;
        }
        let mut out = self.writer();
        let mut at = 0;
        for (i, ch) in self.char_indices() {
            if ch != '\r' {
                continue;
            }
            if i < at {
                continue;
            }
            out.copy(&self[at..i]);
            let end = i + if self[i..].starts_with("\r\n") { 2 } else { 1 };
            out.replace("\n", i..end);
            at = end;
        }
        out.copy(&self[at..]);
        out.finish()
    }
    /// Canonical byte intervals of an input range, without assigning glyphs.
    /// Synthetic repair syntax has no source interval.
    pub(super) fn ranges(&self, range: Range<usize>) -> Vec<Range<u64>> {
        let first = self
            .pieces
            .partition_point(|piece| piece.rendered.end <= range.start);
        let mut ranges = self.pieces[first..]
            .iter()
            .take_while(|piece| piece.rendered.start < range.end)
            .filter_map(|piece| {
                let start = piece.rendered.start.max(range.start);
                let end = piece.rendered.end.min(range.end);
                (start < end).then(|| {
                    if piece.literal {
                        (piece.original.start + start - piece.rendered.start) as u64
                            ..(piece.original.start + end - piece.rendered.start) as u64
                    } else {
                        piece.original.start as u64..piece.original.end as u64
                    }
                })
            })
            .collect();
        merge_ranges(&mut ranges);
        ranges
    }

    /// Compose the parser's lexical UTF-16 mapping with rewrite provenance.
    pub(super) fn project(
        &self,
        text: &str,
        segments: Vec<TextSourceSegment>,
    ) -> Vec<TextSourceSegment> {
        let mut out = Vec::new();
        #[cfg(debug_assertions)]
        let units = text.encode_utf16().count() as u32;
        let _ = text;
        for segment in segments {
            let a = segment.source_start as usize;
            let b = segment.source_end as usize;
            let first = self.pieces.partition_point(|p| p.rendered.end <= a);
            let pieces = self.pieces[first..]
                .iter()
                .take_while(|p| p.rendered.start < b);
            if segment.kind == TextSourceKind::Replacement {
                let mut original: Option<Range<usize>> = None;
                for p in pieces {
                    let s = p.rendered.start.max(a);
                    let e = p.rendered.end.min(b);
                    let r = if p.literal {
                        p.original.start + s - p.rendered.start
                            ..p.original.start + e - p.rendered.start
                    } else {
                        p.original.clone()
                    };
                    original = Some(match original {
                        Some(old) => old.start.min(r.start)..old.end.max(r.end),
                        None => r,
                    });
                }
                if let Some(r) = original {
                    let mut s = segment;
                    s.source_start = r.start as u64;
                    s.source_end = r.end as u64;
                    out.push(s);
                }
                continue;
            }
            // Literal lexical segments have equal byte lengths. Only copied
            // portions get addresses; synthetic streaming closers remain gaps.
            for p in pieces {
                let s = p.rendered.start.max(a);
                let e = p.rendered.end.min(b);
                let start = segment.start + self[a..s].encode_utf16().count() as u32;
                let end = start + self[s..e].encode_utf16().count() as u32;
                let r = if p.literal {
                    p.original.start + s - p.rendered.start..p.original.start + e - p.rendered.start
                } else {
                    p.original.clone()
                };
                out.push(TextSourceSegment {
                    start,
                    end,
                    source_start: r.start as u64,
                    source_end: r.end as u64,
                    kind: if p.literal {
                        TextSourceKind::Literal
                    } else {
                        TextSourceKind::Replacement
                    },
                });
            }
        }
        // Validate against the actual rendered text at the parser boundary.
        #[cfg(debug_assertions)]
        debug_assert!(out.iter().all(|s| s.end <= units));
        out
    }
}
/// Root rows can include several disjoint original pieces (notably footnotes).
pub(super) fn merge_ranges(ranges: &mut Vec<Range<u64>>) {
    ranges.retain(|range| range.start < range.end);
    ranges.sort_unstable_by_key(|range| (range.start, range.end));
    let mut kept = 0;
    for index in 0..ranges.len() {
        if kept > 0 && ranges[index].start <= ranges[kept - 1].end {
            ranges[kept - 1].end = ranges[kept - 1].end.max(ranges[index].end);
        } else {
            ranges.swap(kept, index);
            kept += 1;
        }
    }
    ranges.truncate(kept);
}

pub(super) struct Writer<'a> {
    input: &'a Source,
    out: Source,
}
impl Writer<'_> {
    /// A borrowed lexical slice of the input; never a substring lookup.
    pub(super) fn copy(&mut self, slice: &str) {
        let a = slice.as_ptr() as usize - self.input.as_ptr() as usize;
        let b = a + slice.len();
        let offset = self.out.text.len();
        self.out.text.push_str(slice);
        let first = self.input.pieces.partition_point(|p| p.rendered.end <= a);
        for p in self.input.pieces[first..]
            .iter()
            .take_while(|p| p.rendered.start < b)
        {
            let s = p.rendered.start.max(a);
            let e = p.rendered.end.min(b);
            let original = if p.literal {
                p.original.start + s - p.rendered.start..p.original.start + e - p.rendered.start
            } else {
                p.original.clone()
            };
            self.out.pieces.push(Piece {
                rendered: offset + s - a..offset + e - a,
                original,
                literal: p.literal,
            });
        }
    }
    pub(super) fn push_str(&mut self, text: &str) {
        self.out.push(text);
    }
    pub(super) fn push(&mut self, ch: char) {
        self.out.text.push(ch);
    }
    pub(super) fn replace_slice(&mut self, text: &str, original: &str) {
        let start = original.as_ptr() as usize - self.input.as_ptr() as usize;
        self.replace(text, start..start + original.len());
    }
    pub(super) fn replace(&mut self, text: &str, range: Range<usize>) {
        let mapped = self.input.slice(range);
        let start = self.out.text.len();
        self.out.push(text);
        if let (Some(a), Some(b)) = (mapped.pieces.first(), mapped.pieces.last()) {
            self.out.pieces.push(Piece {
                rendered: start..self.out.text.len(),
                original: a.original.start..b.original.end,
                literal: false,
            });
        }
    }
    pub(super) fn finish(self) -> Source {
        self.out
    }
}
