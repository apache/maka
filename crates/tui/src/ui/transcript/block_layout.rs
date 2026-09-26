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

//! Materialize one visible block through the existing shared renderer.
use super::*;

#[derive(Clone, PartialEq, Eq)]
pub(super) enum Request {
    Rows(std::ops::Range<usize>),
    Tail(usize),
    Source {
        source: std::ops::Range<usize>,
        before: usize,
        rows: usize,
    },
    Logical {
        offset: usize,
        before: usize,
        rows: usize,
    },
}

impl Transcript {
    pub(super) fn layout_block(
        &mut self,
        index: usize,
        ascii: bool,
        padded: bool,
    ) -> Result<(), &'static str> {
        let key = self.order[index].clone();
        let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
        let width = self.width;
        let block = self.blocks.get_mut(&key).expect("indexed block");
        if block.dirty || block.layout.is_none() || block.layout_epoch != self.layout_epoch {
            let selected_text = self
                .text_selection
                .references(&key)
                .then(|| block.semantic.clone())
                .flatten();
            if block.layout_epoch != self.layout_epoch {
                block.layout = None;
                block.markdown = Default::default();
            }
            let time_width = if width >= 60 {
                block.time.as_ref().map_or(0, |time| time.len() as u16 + 2)
            } else {
                0
            };
            let body_width = width.saturating_sub(2 + block.indent + time_width).max(1);
            block.layout = Some(if block.folded && block.kind == Kind::User {
                let (layout, expandable) =
                    prompt::preview_from(&block.text, body_width, ascii, &block.preview)?;
                block.expandable = expandable;
                layout
            } else if block.folded {
                let preview_width = body_width;
                let preview_start = block.preview.start;
                let preview = &block.text[preview_start..block.preview.first_end];
                let more_lines = block.preview.end > block.preview.first_end;
                let first_len = preview.len();
                // Inspect a bounded first-line preview, including Markdown
                // syntax, to distinguish real omitted content from decoration.
                let preview = block::preview_text(preview, usize::from(preview_width) * 4 + 32);
                let mut layout = if block.kind.markdown() {
                    layout::markdown(&preview, preview_width, ascii)?
                } else {
                    layout::plain(&preview, preview_width)?
                };
                block.expandable = block.kind.group()
                    || more_lines
                    || preview.len() < first_len
                    || layout
                        .lines
                        .iter()
                        .skip(1)
                        .any(|line| !line.line.to_string().trim().is_empty());
                let clipped = layout.lines.len() > 1;
                layout.lines.truncate(1);
                // Whole-word wrapping can drop a word from a one-row preview;
                // mark it rather than end on a silently shortened sentence.
                let line = &mut layout.lines[0].line;
                if clipped && line.width() < usize::from(preview_width) {
                    line.spans.push(Span::raw(if ascii { "." } else { "…" }));
                }
                let end = layout.lines[0]
                    .mapping
                    .iter()
                    .map(|span| span.logical.end)
                    .max()
                    .unwrap_or(0);
                layout.text.truncate(end);
                for line in &mut layout.lines {
                    line.source += preview_start;
                    for span in &mut line.mapping {
                        span.source.start += preview_start;
                        span.source.end += preview_start;
                    }
                }
                layout
            } else if block.kind.markdown() {
                block.markdown.render(
                    &block.text,
                    body_width,
                    ascii,
                    block.layout.take(),
                    self.colors,
                )?
            } else {
                layout::diff::render_colored(
                    &block.text,
                    &block.changes,
                    body_width,
                    ascii,
                    self.colors,
                )?
            });
            if !block.folded {
                block.expandable = block.kind.group()
                    || block
                        .layout
                        .as_ref()
                        .unwrap()
                        .lines
                        .iter()
                        .skip(if block.kind == Kind::User { 3 } else { 1 })
                        .any(|line| !line.line.to_string().trim().is_empty());
            }
            if block.kind == Kind::Timing {
                let layout = block.layout.as_mut().unwrap();
                layout.text.clear();
                for line in &mut layout.lines {
                    line.mapping.clear();
                }
            }
            block.header = 0;
            if block.kind == Kind::User && padded {
                // Band padding rows carry no source text, so selection,
                // search and copy skip them like any other decoration.
                let lines = &mut block.layout.as_mut().unwrap().lines;
                let pad = |source| layout::VisualLine {
                    line: Line::default(),
                    source,
                    mapping: vec![],
                };
                let (first, last) = (lines[0].source, lines[lines.len() - 1].source);
                lines.insert(0, pad(first));
                lines.push(pad(last));
                block.header = 1;
            }
            if let Some(previous) = selected_text {
                self.text_selection
                    .rebase(&key, &previous, &block.layout.as_ref().unwrap().text);
            }
            block.semantic = Some(std::sync::Arc::from(
                block.layout.as_ref().unwrap().text.as_str(),
            ));
            block.dirty = false;
            block.layout_epoch = self.layout_epoch;
            #[cfg(test)]
            {
                self.builds += 1;
            }
        }

        let rows = block.layout.as_ref().unwrap().lines.len();
        block.measured_rows = Some(rows);
        self.starts
            .set(index, rows + usize::from(gap_after(block, next)));
        self.cached.insert(key);
        #[cfg(test)]
        if let Some(stats) = &mut self.measurement {
            stats.visited_blocks += 1;
        }
        Ok(())
    }
}
