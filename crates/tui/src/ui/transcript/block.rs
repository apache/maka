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

//! Semantic content and disposable visual geometry have distinct lifetimes.
use super::*;
pub(super) struct PreviewFrame {
    pub origin: usize,
    pub lines: Vec<layout::VisualLine>,
    pub bytes: usize,
}
impl PreviewFrame {
    pub fn capture(block: &Block) -> Option<Self> {
        let lines = block.visual_lines();
        if lines.is_empty() {
            return None;
        }
        let lines: Vec<_> = lines
            .iter()
            .map(|line| layout::VisualLine {
                line: line.line.clone(),
                source: line.source,
                mapping: line.mapping.clone(),
            })
            .collect();
        let bytes = lines.capacity() * std::mem::size_of::<layout::VisualLine>()
            + lines
                .iter()
                .map(|line| {
                    line.mapping.capacity() * std::mem::size_of::<layout::SourceSpan>()
                        + line.line.spans.capacity() * std::mem::size_of::<Span<'static>>()
                        + line
                            .line
                            .spans
                            .iter()
                            .map(|span| match &span.content {
                                std::borrow::Cow::Owned(text) => text.capacity(),
                                _ => 0,
                            })
                            .sum::<usize>()
                })
                .sum::<usize>();
        Some(Self {
            origin: block.visual_origin(),
            lines,
            bytes,
        })
    }
}
#[derive(Default)]
pub(super) struct Preview {
    pub start: usize,
    pub first_end: usize,
    pub end: usize,
}
pub(super) fn source_shape(text: &str) -> (usize, Preview) {
    let mut shape = Preview::default();
    let mut offset = 0;
    let mut rows: usize = 0;
    let mut seen = false;
    for line in text.split_inclusive('\n') {
        rows += 1;
        if !line.trim().is_empty() {
            if !seen {
                shape.start = offset;
                shape.first_end = offset + line.trim_end_matches(['\r', '\n']).len();
                seen = true;
            }
            shape.end = offset + line.trim_end().len();
        }
        offset += line.len();
    }
    if !seen {
        shape.start = text.len();
        shape.first_end = text.len();
        shape.end = text.len();
    }
    (rows.max(1), shape)
}
pub(super) fn preview_text(text: &str, glyphs: usize) -> String {
    let mut bytes = 0;
    text.graphemes(true)
        .take(glyphs)
        .take_while(|grapheme| {
            bytes += grapheme.len();
            bytes <= large::INLINE_BYTES
        })
        .collect()
}
impl Block {
    pub(super) fn visual_current(&self) -> bool {
        self.previous_frame.is_none() || self.large.as_ref().is_some_and(large::State::ready)
    }
    pub(super) fn windowed(&self) -> bool {
        !self.folded && self.text.len() > large::INLINE_BYTES
    }
    pub(super) fn selection_text(&self) -> Option<&str> {
        if self.dirty {
            return None;
        }
        self.semantic
            .as_deref()
            .or_else(|| self.layout.as_ref().map(|layout| layout.text.as_str()))
    }
    pub(super) fn message_text(&self) -> Option<&str> {
        if self.dirty {
            return None;
        }
        self.large
            .as_ref()
            .and_then(large::State::text)
            .or_else(|| (!self.folded).then(|| self.selection_text()).flatten())
    }
    pub(super) fn visual_lines(&self) -> &[layout::VisualLine] {
        if self.windowed() {
            if let Some(previous) = &self.previous_frame
                && self.large.as_ref().is_none_or(|state| !state.ready())
            {
                return &previous.lines;
            }
            self.large.as_ref().map_or(&[], large::State::lines)
        } else {
            self.layout
                .as_ref()
                .map_or(&[], |layout| layout.lines.as_slice())
        }
    }
    pub(super) fn visual_origin(&self) -> usize {
        if self.windowed() {
            if let Some(previous) = &self.previous_frame
                && self.large.as_ref().is_none_or(|state| !state.ready())
            {
                return previous.origin;
            }
            self.large.as_ref().map_or(0, large::State::origin) + self.header
        } else {
            0
        }
    }
    pub(super) fn visual_line(&self, row: usize) -> Option<&layout::VisualLine> {
        self.visual_lines()
            .get(row.checked_sub(self.visual_origin())?)
    }
    pub(super) fn rows(&self) -> usize {
        if self.windowed() {
            self.large
                .as_ref()
                .and_then(large::State::rows)
                .map(|rows| rows + self.header * 2)
                .unwrap_or_else(|| {
                    self.measured_rows.unwrap_or(self.source_lines).max(
                        self.large.as_ref().map_or(1, large::State::measured) + self.header * 2,
                    )
                })
        } else {
            self.layout
                .as_ref()
                .map_or(self.measured_rows.unwrap_or(1), |layout| layout.lines.len())
        }
        .max(1)
    }
    pub(super) fn body_width(&self, width: u16) -> u16 {
        let time_width = if width >= 60 {
            self.time.as_ref().map_or(0, |time| time.len() as u16 + 2)
        } else {
            0
        };
        width.saturating_sub(2 + self.indent + time_width).max(1)
    }
    pub(super) fn source_row(&self, source: usize) -> usize {
        if self.windowed()
            && let Some(row) = self.large.as_ref().and_then(large::State::located)
        {
            return row + self.header;
        }
        let lines = self.visual_lines();
        lines
            .iter()
            .position(|line| {
                line.mapping
                    .iter()
                    .any(|span| span.source.contains(&source))
            })
            .or_else(|| lines.iter().rposition(|line| line.source <= source))
            .unwrap_or(0)
            + self.visual_origin()
    }
    pub(super) fn geometry_bytes(&self) -> usize {
        self.layout.as_ref().map_or(0, |layout| layout.bytes)
            + self.previous_frame.as_ref().map_or(0, |frame| frame.bytes)
            + self.markdown.syntax_bytes()
            + self.large.as_ref().map_or(0, large::State::bytes)
            + self.semantic.as_ref().map_or(0, |text| {
                if self
                    .large
                    .as_ref()
                    .is_some_and(|state| state.shares_text(text))
                {
                    0
                } else {
                    text.len()
                }
            })
    }
}
