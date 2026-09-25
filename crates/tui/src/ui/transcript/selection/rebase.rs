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

impl Selection {
    pub(in crate::ui::transcript) fn references(&self, key: &MessageKey) -> bool {
        self.drag
            .as_ref()
            .is_some_and(|drag| &drag.anchor.key == key)
            || self
                .extent
                .as_ref()
                .is_some_and(|extent| &extent.anchor.key == key || &extent.head.key == key)
            || self.ranges.iter().any(|segment| &segment.key == key)
    }

    /// Preserve gestures only within unchanged grapheme prefixes/suffixes.
    /// A changed selected body is invalidated, never silently copied as new text.
    pub(in crate::ui::transcript) fn rebase(&mut self, key: &MessageKey, old: &str, new: &str) {
        if old == new {
            return;
        }
        let prefix: usize = old
            .graphemes(true)
            .zip(new.graphemes(true))
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len())
            .sum();
        let suffix: usize = old[prefix..]
            .graphemes(true)
            .rev()
            .zip(new[prefix..].graphemes(true).rev())
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len())
            .sum();
        let old_end = old.len() - suffix;
        let new_end = new.len() - suffix;
        let range = |range: &Range<usize>| {
            if range.end <= prefix {
                Some(range.clone())
            } else if range.start >= old_end {
                Some(new_end + (range.start - old_end)..new_end + (range.end - old_end))
            } else {
                None
            }
        };
        let caret = |caret: &mut Caret| {
            if &caret.key != key
                || caret.offset < prefix
                || (caret.offset == prefix && caret.trailing)
            {
                true
            } else if caret.offset > old_end || (caret.offset == old_end && !caret.trailing) {
                caret.offset = new_end + (caret.offset - old_end);
                true
            } else {
                false
            }
        };
        if let Some(extent) = &mut self.extent {
            if !caret(&mut extent.anchor) || !caret(&mut extent.head) {
                self.clear();
                return;
            }
            extent.column = None;
        }
        if let Some(drag) = &mut self.drag
            && &drag.anchor.key == key
        {
            let Some(updated) = range(&drag.anchor.range) else {
                self.clear();
                return;
            };
            drag.anchor.range = updated;
        }
        for segment in &mut self.ranges {
            if &segment.key == key {
                let Some(updated) = range(&segment.range) else {
                    self.clear();
                    return;
                };
                segment.range = updated;
            }
        }
    }
}
