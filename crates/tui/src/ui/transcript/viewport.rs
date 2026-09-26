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

//! Resolve a logical bookmark, then materialize only its bounded reading window.
use super::{block_layout::Request, *};
#[derive(Clone, Copy)]
struct Cursor {
    index: usize,
    row: usize,
}
impl Transcript {
    pub(super) fn layout_viewport(
        &mut self,
        width: u16,
        ascii: bool,
        padded: bool,
        height: usize,
    ) -> Result<(), &'static str> {
        if self.width != width
            || self.layout_colors != self.colors
            || self.layout_padded != padded
            || self.layout_ascii != ascii
        {
            self.invalidate();
            self.width = width;
            self.layout_colors = self.colors;
            self.layout_padded = padded;
            self.layout_ascii = ascii;
        }
        self.height = height;
        self.pending_layouts.clear();
        if self.starts.len() != self.order.len() {
            self.indexes.clear();
            self.indexes.extend(
                self.order
                    .iter()
                    .cloned()
                    .enumerate()
                    .map(|(index, key)| (key, index)),
            );
            self.starts
                .reset(self.order.iter().enumerate().map(|(index, key)| {
                    let block = &self.blocks[key];
                    let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
                    let estimate = block.measured_rows.unwrap_or_else(|| {
                        if block.folded {
                            if block.kind == Kind::User {
                                block.source_lines.min(3) + usize::from(padded) * 2
                            } else {
                                1
                            }
                        } else {
                            block
                                .source_lines
                                .max(block.text.len().div_ceil(usize::from(width.max(1))))
                        }
                    });
                    estimate.max(1) + usize::from(gap_after(block, next))
                }));
        }
        self.total = self.starts.total();
        if self.order.is_empty() {
            self.top = 0;
            self.cached.clear();
            return Ok(());
        }
        self.validate_text_selection();
        if self.text_selection.preparing_geometry() {
            return self.trim_viewport(
                self.starts.at(self.top),
                self.starts.at(self.top.saturating_add(height * 2)),
            );
        }
        let requested_row = self
            .row_request
            .clone()
            .and_then(|(key, row)| self.indexes.get(&key).copied().map(|index| (index, row)));
        let origin = if let Some((index, row)) = requested_row {
            if self.ensure_geometry(
                index,
                Request::Rows(row.saturating_sub(height)..row.saturating_add(height * 3)),
            )? {
                Some(Cursor {
                    index,
                    row: row.min(self.blocks[&self.order[index]].rows().saturating_sub(1)),
                })
            } else {
                None
            }
        } else if let Some(anchor) = self.anchor.clone()
            && let Some(&index) = self.indexes.get(&anchor.key)
        {
            let known = self
                .anchor_row
                .as_ref()
                .filter(|(previous, _, epoch)| previous == &anchor && *epoch == self.layout_epoch)
                .map(|(_, row, _)| *row);
            let request = known.map_or_else(
                || Request::Source {
                    source: anchor.source..anchor.source.saturating_add(1),
                    before: height,
                    rows: height.saturating_mul(4),
                },
                |row| Request::Rows(row.saturating_sub(height)..row.saturating_add(height * 3)),
            );
            if self.ensure_geometry(index, request)? {
                let row =
                    known.unwrap_or_else(|| self.blocks[&anchor.key].source_row(anchor.source));
                let screen_row = if anchor.screen_row < height {
                    anchor.screen_row
                } else {
                    height / 3
                };
                self.backward(Cursor { index, row }, screen_row)?
            } else {
                None
            }
        } else {
            self.tail(height)?
        };
        let Some(mut origin) = origin else {
            self.top = self.top.min(self.total.saturating_sub(height));
            return self.trim_viewport(
                self.starts.at(self.top),
                self.starts.at(self.top.saturating_add(height * 2)),
            );
        };
        let mut reveal = false;
        if self.focused
            && let Some(index) = self
                .selected
                .as_ref()
                .and_then(|key| self.indexes.get(key))
                .copied()
        {
            let top = self.starts.start(origin.index) + origin.row;
            let start = self.starts.start(index);
            if (start < top || start >= top + height)
                && self.ensure_geometry(index, Request::Rows(0..height.saturating_mul(4)))?
                && let Some(next) = self.backward(
                    Cursor { index, row: 0 },
                    if start < top {
                        0
                    } else {
                        height.saturating_sub(1)
                    },
                )?
            {
                origin = next;
                reveal = true;
            }
        }
        let first = self
            .backward(origin, height)?
            .map_or(origin.index, |cursor| cursor.index);
        let last = self.cover(origin, height.saturating_mul(2))?;
        self.total = self.starts.total();
        self.top = self.starts.start(origin.index) + origin.row;
        if self.top > self.total.saturating_sub(height)
            && let Some(tail) = self.tail(height)?
        {
            origin = tail;
            self.top = self.starts.start(origin.index) + origin.row;
            self.total = self.starts.total();
        }
        if reveal || requested_row.is_some() {
            self.row_request = None;
            let anchor = self.position(self.top);
            if self.anchor != anchor {
                self.anchor = anchor;
                self.reading_changes = self.reading_changes.wrapping_add(1);
            }
        }
        self.trim_viewport(first, last)
    }
    fn trim_viewport(&mut self, first: usize, last: usize) -> Result<(), &'static str> {
        // Full-message copying of a collapsed large record prepares semantics without expanding it.
        let message = self.selection();
        if let Some(index) = message
            .as_ref()
            .and_then(|key| self.indexes.get(key))
            .copied()
            && self.blocks[&self.order[index]].text.len() > large::INLINE_BYTES
        {
            self.ensure_message(index)?;
        }
        self.total = self.starts.total();
        let mut bytes = 0;
        let mut rows = 0;
        let geometry = self.text_selection.geometry_key().cloned();
        self.cached.retain(|key| {
            let Some(block) = self.blocks.get_mut(key) else {
                return false;
            };
            let visible = self
                .indexes
                .get(key)
                .is_some_and(|index| (first..=last).contains(index));
            let semantic = self.text_selection.references(key) || message.as_ref() == Some(key);
            let pending = self.pending_layouts.contains(key);
            if !visible && !pending && geometry.as_ref() != Some(key) {
                block.layout = None;
                block.previous_frame = None;
                block.markdown = Default::default();
                if let Some(state) = &mut block.large {
                    state.evict_geometry();
                }
            }
            if !visible && !semantic && !pending {
                block.large = None;
                block.semantic = None;
            }
            bytes += block.geometry_bytes();
            rows += block.visual_lines().len();
            visible || semantic || pending
        });
        if bytes > layout::MAX_BYTES || rows > layout::MAX_LINES {
            return Err("Transcript layout exceeds local capacity");
        }
        Ok(())
    }
    fn ensure_end(&mut self, index: usize) -> Result<bool, &'static str> {
        let key = &self.order[index];
        let block = &self.blocks[key];
        let measured = block
            .windowed()
            .then_some(block.large.as_ref())
            .flatten()
            .filter(|state| state.matches(self.layout_ascii, self.colors))
            .and_then(|state| state.measured_at(block.body_width(self.width)));
        if let Some(rows) = measured {
            let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
            let block = self.blocks.get_mut(key).unwrap();
            block.header = usize::from(block.kind == Kind::User && self.layout_padded);
            let rows = rows + block.header * 2;
            block.measured_rows = Some(rows);
            self.starts
                .set(index, rows + usize::from(gap_after(block, next)));
            return Ok(true);
        }
        self.ensure_geometry(index, Request::Tail(self.height.saturating_mul(4)))
    }
    fn tail(&mut self, height: usize) -> Result<Option<Cursor>, &'static str> {
        let index = self.order.len() - 1;
        if !self.ensure_end(index)? {
            return Ok(None);
        }
        self.backward(
            Cursor {
                index,
                row: self.starts.height(index),
            },
            height,
        )
    }
    fn backward(
        &mut self,
        mut cursor: Cursor,
        mut rows: usize,
    ) -> Result<Option<Cursor>, &'static str> {
        loop {
            if rows <= cursor.row {
                cursor.row -= rows;
                return Ok(Some(cursor));
            }
            rows -= cursor.row;
            if cursor.index == 0 {
                return Ok(Some(Cursor { index: 0, row: 0 }));
            }
            cursor.index -= 1;
            if !self.ensure_end(cursor.index)? {
                return Ok(None);
            }
            cursor.row = self.starts.height(cursor.index);
        }
    }
    fn cover(&mut self, mut cursor: Cursor, mut rows: usize) -> Result<usize, &'static str> {
        loop {
            if !self.ensure_geometry(
                cursor.index,
                Request::Rows(cursor.row..cursor.row.saturating_add(rows)),
            )? {
                return Ok(cursor.index);
            }
            let available = self.starts.height(cursor.index).saturating_sub(cursor.row);
            if available >= rows || cursor.index + 1 == self.order.len() {
                return Ok(cursor.index);
            }
            rows -= available;
            cursor.index += 1;
            cursor.row = 0;
        }
    }
}
