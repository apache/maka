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

use super::*;

/// Resume validation and collection without retaining visual layouts or partial copies.
pub(super) struct Resolution {
    collect: Option<Collection>,
    validation: Option<usize>,
    pub(super) key: Option<MessageKey>,
}
struct Collection {
    bounds: (usize, usize, usize, usize),
    next: usize,
    bytes: usize,
}

/// Empty records and decoration still consume traversal work.
pub(super) fn scan_work() -> bool {
    if frame_work::allowance(256) < 256 {
        return false;
    }
    frame_work::charge(256);
    true
}

impl Transcript {
    pub(super) fn selection_index(&self, key: &MessageKey) -> Option<usize> {
        self.indexes
            .get(key)
            .copied()
            .filter(|index| self.order.get(*index) == Some(key))
            .or_else(|| self.order.iter().position(|candidate| candidate == key))
    }
    fn selection_bounds(&self, extent: &Extent) -> Option<(usize, usize, usize, usize)> {
        let a = self.selection_index(&extent.anchor.key)?;
        let b = self.selection_index(&extent.head.key)?;
        Some(if (a, extent.anchor.offset) <= (b, extent.head.offset) {
            (a, b, extent.anchor.offset, extent.head.offset)
        } else {
            (b, a, extent.head.offset, extent.anchor.offset)
        })
    }
    pub(super) fn select_extent(&mut self, extent: Extent) {
        let _work = frame_work::begin();
        let Some(bounds) = self.selection_bounds(&extent) else {
            self.text_selection.clear();
            return;
        };
        self.text_selection.extent = Some(extent);
        self.text_selection.ranges.clear();
        self.text_selection.error = None;
        self.text_selection.validating = false;
        self.text_selection.too_large =
            bounds.0 == bounds.1 && bounds.3.saturating_sub(bounds.2) > MAX_COPY_BYTES;
        self.text_selection.pending = Some(Resolution {
            collect: Some(Collection {
                bounds,
                next: bounds.0,
                bytes: 0,
            }),
            validation: None,
            key: None,
        });
        self.resolve_selection();
    }
    fn resolve_selection(&mut self) {
        let Some(mut pending) = self.text_selection.pending.take() else {
            return;
        };
        let result = self.validate_snapshot(&mut pending).and_then(|ready| {
            if ready {
                self.collect_selection(&mut pending)
            } else {
                Ok(false)
            }
        });
        match result {
            Ok(true) => {}
            Ok(false) => {
                self.text_selection.pending = Some(pending);
                self.selection_frame();
            }
            Err(error) => {
                self.text_selection.validating = false;
                self.text_selection.error = Some(error);
            }
        }
    }
    fn validation_key(&self, index: usize) -> Option<&MessageKey> {
        self.text_selection
            .ranges
            .iter()
            .map(|segment| &segment.key)
            .chain(
                self.text_selection
                    .extent
                    .iter()
                    .flat_map(|extent| [&extent.anchor.key, &extent.head.key]),
            )
            .chain(self.text_selection.drag.iter().map(|drag| &drag.anchor.key))
            .nth(index)
    }
    fn validate_snapshot(&mut self, pending: &mut Resolution) -> Result<bool, &'static str> {
        while let Some(cursor) = pending.validation {
            let Some(key) = self.validation_key(cursor).cloned() else {
                pending.validation = None;
                self.text_selection.validating = false;
                break;
            };
            pending.key = Some(key.clone());
            if !scan_work() {
                return Ok(false);
            }
            let Some(index) = self.selection_index(&key) else {
                self.text_selection.clear();
                pending.collect = None;
                return Ok(true);
            };
            if !self
                .ensure_semantic(index)
                .map_err(|_| "chat-copy-unavailable")?
            {
                return Ok(false);
            }
            let Some(text) = self.blocks[&key].selection_text() else {
                return Err("chat-copy-unavailable");
            };
            let invalid_caret = self.text_selection.extent.as_ref().is_some_and(|extent| {
                [&extent.anchor, &extent.head]
                    .into_iter()
                    .any(|caret| caret.key == key && !text.is_char_boundary(caret.offset))
            });
            let invalid_range = self
                .text_selection
                .ranges
                .get(cursor)
                .is_some_and(|segment| {
                    text.get(segment.range.clone())
                        .is_none_or(|text| !self.text_selection.too_large && text != segment.text)
                });
            if invalid_caret || invalid_range {
                self.text_selection.clear();
                pending.collect = None;
                return Ok(true);
            }
            pending.validation = Some(cursor + 1);
        }
        Ok(true)
    }
    fn collect_selection(&mut self, pending: &mut Resolution) -> Result<bool, &'static str> {
        let Some(collect) = &mut pending.collect else {
            return Ok(true);
        };
        loop {
            let Some(bounds) = self
                .text_selection
                .extent
                .as_ref()
                .and_then(|extent| self.selection_bounds(extent))
            else {
                self.text_selection.clear();
                return Ok(true);
            };
            if bounds != collect.bounds {
                self.text_selection.ranges.clear();
                self.text_selection.too_large = false;
                *collect = Collection {
                    bounds,
                    next: bounds.0,
                    bytes: 0,
                };
            }
            let (first, last, start, end) = collect.bounds;
            if collect.next > last {
                return Ok(true);
            }
            let index = collect.next;
            pending.key = Some(self.order[index].clone());
            if !scan_work() {
                return Ok(false);
            }
            if !self
                .ensure_semantic(index)
                .map_err(|_| "chat-copy-unavailable")?
            {
                return Ok(false);
            }
            // Source reconciliation can rebase or cancel the extent.
            if self
                .text_selection
                .extent
                .as_ref()
                .and_then(|extent| self.selection_bounds(extent))
                != Some(collect.bounds)
            {
                continue;
            }
            let key = &self.order[index];
            let text = self.blocks[key]
                .selection_text()
                .ok_or("chat-copy-unavailable")?;
            let range = (if index == first { start } else { 0 })..(if index == last {
                end
            } else {
                text.len()
            });
            let Some(text) = text.get(range.clone()) else {
                self.text_selection.clear();
                return Ok(true);
            };
            collect.next += 1;
            if text.is_empty() {
                continue;
            }
            collect.bytes = collect
                .bytes
                .saturating_add(text.len())
                .saturating_add(usize::from(!self.text_selection.ranges.is_empty()) * 2);
            self.text_selection.too_large |= collect.bytes > MAX_COPY_BYTES;
            self.text_selection.ranges.push(Segment {
                key: key.clone(),
                range,
                text: if self.text_selection.too_large {
                    String::new()
                } else {
                    text.into()
                },
            });
            frame_work::charge(text.len());
        }
    }
    pub(in crate::ui::transcript) fn validate_text_selection(&mut self) {
        let _work = frame_work::begin();
        let collecting = self
            .text_selection
            .pending
            .as_ref()
            .is_some_and(|pending| pending.collect.is_some());
        let stale = |key: &MessageKey| {
            self.selection_index(key).is_none()
                || self.blocks.get(key).is_none_or(|block| {
                    block.selection_text().is_none()
                        || (block.folded && block.layout_epoch != self.layout_epoch)
                })
        };
        let needs_validation =
            self.text_selection.validating
                || self
                    .text_selection
                    .ranges
                    .iter()
                    .any(|segment| stale(&segment.key))
                || (!collecting
                    && self.text_selection.extent.as_ref().is_some_and(|extent| {
                        stale(&extent.anchor.key) || stale(&extent.head.key)
                    }));
        if needs_validation {
            let pending = self.text_selection.pending.get_or_insert(Resolution {
                collect: None,
                validation: None,
                key: None,
            });
            pending.validation.get_or_insert(0);
            self.text_selection.validating = true;
        }
        self.resolve_selection();
        if !self.text_selection.validating && self.text_selection.pending.is_none() {
            self.advance_selection_key();
        }
        if self.text_selection.validating
            || self.text_selection.pending.is_some()
            || !self.text_selection.keys.is_empty()
        {
            self.selection_frame();
        }
    }
    pub(super) fn selection_frame(&mut self) {
        let wait = Duration::from_millis(16);
        self.motion_wait = Some(self.motion_wait.map_or(wait, |old| old.min(wait)));
    }
}
