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

//! Demand-driven preparation; a missing visual cache never means end of content.
use super::{block_layout::Request, *};
use std::sync::Arc;
impl Transcript {
    fn pending_layout(&mut self) {
        let wait = std::time::Duration::from_millis(16);
        self.motion_wait = Some(self.motion_wait.map_or(wait, |old| old.min(wait)));
    }
    pub(super) fn ensure_message(&mut self, index: usize) -> Result<bool, &'static str> {
        let key = self.order[index].clone();
        let block = self.blocks.get_mut(&key).unwrap();
        let previous = (!block.folded && self.text_selection.references(&key))
            .then(|| block.semantic.clone())
            .flatten();
        if block.large.as_ref().is_none_or(|state| {
            !state.matches(self.layout_ascii, self.colors)
                || previous
                    .as_ref()
                    .is_some_and(|text| !state.prepares_text(text))
        }) {
            if previous.is_none() && !block.folded {
                block.semantic = None;
            }
            block.large =
                Some(large::State::new(self.layout_ascii, self.colors).with_previous(previous));
        }
        let input = || {
            if block.kind.markdown() {
                preparation::Input::Markdown
            } else if block.changes.is_empty() {
                preparation::Input::Plain
            } else {
                preparation::Input::Diff(Arc::from(block.changes.as_slice()))
            }
        };
        let ready = block.large.as_mut().unwrap().prepare(&block.text, input)?;
        if ready && !block.folded {
            let text = block.large.as_ref().unwrap().shared_text().unwrap();
            if let Some(previous) = &block.semantic
                && self.text_selection.references(&key)
                && !Arc::ptr_eq(previous, &text)
            {
                let (basis, mapping) = block
                    .large
                    .as_ref()
                    .unwrap()
                    .rebase()
                    .ok_or("Transcript selection preparation is unavailable")?;
                if !Arc::ptr_eq(basis, previous) {
                    return Err("Transcript selection preparation changed");
                }
                self.text_selection.apply_rebase(&key, mapping);
            }
            block.large.as_mut().unwrap().finish_rebase();
            block.semantic = Some(text);
            block.dirty = false;
        }
        self.cached.insert(key);
        if !ready {
            self.pending_layout();
        }
        Ok(ready)
    }
    pub(super) fn ensure_semantic(&mut self, index: usize) -> Result<bool, &'static str> {
        let key = self.order[index].clone();
        let block = &self.blocks[&key];
        if !block.dirty
            && block.semantic.is_some()
            && (!block.folded || block.layout_epoch == self.layout_epoch)
        {
            return Ok(true);
        }
        if block.folded {
            return self.ensure_geometry(index, Request::Rows(0..self.height.max(1)));
        }
        if block.windowed() {
            return self.ensure_message(index);
        }
        let work = block.text.len().saturating_add(256);
        if frame_work::allowance(work) < work {
            self.pending_layout();
            return Ok(false);
        }
        frame_work::charge(work);
        let text: Arc<str> = if block.kind == Kind::Timing {
            Arc::from("")
        } else if block.kind.markdown() {
            layout::prepared::Document::markdown(&block.text, self.layout_ascii, self.colors)?
                .shared_text()
        } else {
            layout::prepared::Document::diff(
                &block.text,
                &block.changes,
                self.layout_ascii,
                self.colors,
            )?
            .shared_text()
        };
        let block = self.blocks.get_mut(&key).unwrap();
        if let Some(previous) = &block.semantic
            && self.text_selection.references(&key)
        {
            self.text_selection.rebase(&key, previous, &text);
        }
        if block.dirty {
            block.layout = None;
        }
        block.semantic = Some(text);
        block.dirty = false;
        self.cached.insert(key);
        Ok(true)
    }
    pub(super) fn ensure_geometry(
        &mut self,
        index: usize,
        request: Request,
    ) -> Result<bool, &'static str> {
        let _work = frame_work::begin();
        let key = self.order[index].clone();
        if !self.blocks[&key].windowed() {
            // Large previews also validate indivisible graphemes on the CPU lane.
            if self.blocks[&key].text.len() > large::INLINE_BYTES
                && (self.blocks[&key].dirty || self.blocks[&key].layout_epoch != self.layout_epoch)
            {
                self.blocks.get_mut(&key).unwrap().layout = None;
            }
            if self.blocks[&key].text.len() > large::INLINE_BYTES && !self.ensure_message(index)? {
                self.pending_layouts.insert(key);
                return Ok(false);
            }
            let block = &self.blocks[&key];
            if block.dirty || block.layout.is_none() || block.layout_epoch != self.layout_epoch {
                let work = block
                    .text
                    .len()
                    .min(large::INLINE_BYTES)
                    .saturating_add(256);
                if frame_work::allowance(work) < work {
                    self.blocks.get_mut(&key).unwrap().layout = None;
                    self.pending_layouts.insert(key);
                    self.pending_layout();
                    return Ok(false);
                }
                frame_work::charge(work);
            }
            self.layout_block(index, self.layout_ascii, self.layout_padded)?;
            return Ok(true);
        }
        // A different source never borrows the geometry or authority of the previous revision.
        self.blocks.get_mut(&key).unwrap().layout = None;
        if !self.ensure_message(index)? {
            self.pending_layouts.insert(key);
            return Ok(false);
        }
        let block = self.blocks.get_mut(&key).unwrap();
        block.header = usize::from(block.kind == Kind::User && self.layout_padded);
        let request = match request {
            Request::Rows(rows) => Request::Rows(
                rows.start.saturating_sub(block.header)..rows.end.saturating_sub(block.header),
            ),
            other => other,
        };
        let width = block.body_width(self.width);
        let ready = block.large.as_mut().unwrap().advance(width, request)?;
        if ready {
            block.previous_frame = None;
        }
        block.layout_epoch = self.layout_epoch;
        if let Some(rows) = block.large.as_ref().unwrap().rows() {
            block.measured_rows = Some(rows + block.header * 2);
            block.expandable = rows > if block.kind == Kind::User { 3 } else { 1 };
        }
        let rows = block.rows();
        let next = self.order.get(index + 1).map(|key| self.blocks[key].kind);
        if self.starts.len() == self.order.len() {
            let height = rows + usize::from(gap_after(&self.blocks[&key], next));
            let height = if self.blocks[&key]
                .large
                .as_ref()
                .and_then(large::State::rows)
                .is_some()
            {
                height
            } else {
                height.max(self.starts.height(index))
            };
            self.starts.set(index, height);
        }
        self.cached.insert(key.clone());
        if !ready {
            self.pending_layouts.insert(key);
            self.pending_layout();
        }
        Ok(ready)
    }
}
