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

//! Styled, optionally atomic ranges in a plain-text input. Rules are shared
//! with the native editors; matching always uses their current committed text.

use std::ops::Range;

use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

use crate::{Color, Points};

/// Drawing only: token styles do not alter text metrics or source offsets.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputTokenStyle {
    pub color: Option<Color>,
    pub background_color: Option<Color>,
    pub border_radius: Points,
}

/// A regular expression whose named `token` capture identifies the range.
/// Context outside that capture is not styled or made atomic.
#[derive(Clone, Debug)]
pub struct InputTokenRule {
    pattern: Regex,
    pub style: InputTokenStyle,
    pub atomic: bool,
}

impl PartialEq for InputTokenRule {
    fn eq(&self, other: &Self) -> bool {
        self.pattern.as_str() == other.pattern.as_str()
            && self.style == other.style
            && self.atomic == other.atomic
    }
}

impl InputTokenRule {
    /// Compiles a Rust regular expression with a named `token` capture.
    pub fn new(pattern: &str, style: InputTokenStyle, atomic: bool) -> Result<Self, String> {
        let pattern = Regex::new(pattern).map_err(|error| error.to_string())?;
        if !pattern.capture_names().any(|name| name == Some("token")) {
            return Err("an input token pattern needs a named `token` capture".into());
        }
        Ok(Self {
            pattern,
            style,
            atomic,
        })
    }

    pub fn pattern(&self) -> &str {
        self.pattern.as_str()
    }
}

/// A current source range (UTF-8 bytes), with no replacement display string.
#[derive(Clone, Debug, PartialEq)]
pub struct InputTokenSpan {
    pub range: Range<usize>,
    pub style: InputTokenStyle,
    pub atomic: bool,
}

/// Whether an edit continues an unfinished token or confirms its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenEdit {
    Typing,
    Delete,
    Commit,
}

/// Rules and ranges retained by one editor. The small pending range is the
/// token being typed, which remains editable until the caret leaves it or an
/// explicit replacement, paste or delimiter confirms it. Undo stores this
/// range beside the editor's existing text and selection snapshot.
#[derive(Clone, Debug, Default)]
pub struct InputTokens {
    rules: Vec<InputTokenRule>,
    spans: Vec<InputTokenSpan>,
    pending: Option<Range<usize>>,
}

impl InputTokens {
    pub fn set_rules(&mut self, rules: &[InputTokenRule], text: &str) -> bool {
        if self.rules == rules {
            return false;
        }
        let pending = self.pending.clone();
        self.rules = rules.to_vec();
        self.restore(text, pending);
        true
    }

    pub fn spans(&self) -> &[InputTokenSpan] {
        &self.spans
    }

    pub fn pending(&self) -> Option<Range<usize>> {
        self.pending.clone()
    }

    /// A genuinely different externally assigned value is already committed.
    pub fn reset(&mut self, text: &str) {
        self.pending = None;
        self.scan(text);
    }

    pub fn restore(&mut self, text: &str, pending: Option<Range<usize>>) {
        self.reset(text);
        self.pending = pending.filter(|range| self.spans.iter().any(|s| s.range == *range));
    }

    fn scan(&mut self, text: &str) {
        self.spans.clear();
        if self.rules.is_empty() {
            return;
        }
        // Build the complete source boundaries once for all captures. The
        // editor's UTF-8/CRLF boundary helper does not identify full graphemes.
        let boundaries: Vec<_> = text
            .grapheme_indices(true)
            .map(|(offset, _)| offset)
            .chain(std::iter::once(text.len()))
            .collect();
        let mut found_spans = Vec::new();
        for (priority, rule) in self.rules.iter().enumerate() {
            // Resume at the capture's end, rather than the whole match's,
            // so adjacent tokens can share delimiter context.
            let mut at = 0;
            while let Some(found) = rule.pattern.captures_at(text, at) {
                let whole = found.get(0).expect("a regex match");
                let Some(token) = found.name("token").filter(|m| !m.is_empty()) else {
                    if whole.end() > at {
                        at = whole.end();
                        continue;
                    }
                    let next = at;
                    let Some(ch) = text[next..].chars().next() else {
                        break;
                    };
                    at = next + ch.len_utf8();
                    continue;
                };
                let range = token.start()..token.end();
                if boundaries.binary_search(&range.start).is_ok()
                    && boundaries.binary_search(&range.end).is_ok()
                {
                    found_spans.push((
                        priority,
                        InputTokenSpan {
                            range,
                            style: rule.style,
                            atomic: rule.atomic,
                        },
                    ));
                }
                at = token.end();
            }
        }
        // Earliest source match wins; declaration order breaks ties. Resolve
        // overlaps once, rather than scanning all earlier ranges per token.
        found_spans.sort_by_key(|(priority, span)| (span.range.start, *priority));
        for (_, span) in found_spans {
            if self
                .spans
                .last()
                .is_none_or(|previous| previous.range.end <= span.range.start)
            {
                self.spans.push(span);
            }
        }
    }

    fn atom(&self, span: &InputTokenSpan) -> bool {
        span.atomic && self.pending.as_ref() != Some(&span.range)
    }

    pub fn is_caret(&self, at: usize) -> bool {
        !self
            .spans
            .iter()
            .any(|s| self.atom(s) && s.range.start < at && at < s.range.end)
    }

    /// A directional movement never snaps back to the edge it came from.
    pub fn step(&self, at: usize, forward: bool) -> usize {
        self.spans
            .iter()
            .find(|s| self.atom(s) && s.range.start < at && at < s.range.end)
            .map_or(at, |s| if forward { s.range.end } else { s.range.start })
    }

    /// Selections and replacement ranges cannot include half an atom.
    pub fn expand(&self, mut range: Range<usize>) -> Range<usize> {
        for span in &self.spans {
            if self.atom(span) && range.start < span.range.end && span.range.start < range.end {
                range.start = range.start.min(span.range.start);
                range.end = range.end.max(span.range.end);
            }
        }
        range
    }

    pub fn intersects_atom(&self, range: &Range<usize>) -> bool {
        self.spans
            .iter()
            .any(|s| self.atom(s) && range.start < s.range.end && s.range.start < range.end)
    }

    pub fn select(&mut self, anchor: usize, caret: usize) -> (usize, usize) {
        if self
            .pending
            .as_ref()
            .is_some_and(|r| anchor < r.start || anchor > r.end || caret < r.start || caret > r.end)
        {
            self.pending = None;
        }
        if anchor == caret {
            let at = self
                .spans
                .iter()
                .find(|s| self.atom(s) && s.range.start < caret && caret < s.range.end)
                .map_or(caret, |s| {
                    if caret - s.range.start < s.range.end - caret {
                        s.range.start
                    } else {
                        s.range.end
                    }
                });
            return (at, at);
        }
        let range = self.expand(anchor.min(caret)..anchor.max(caret));
        if anchor < caret {
            (range.start, range.end)
        } else {
            (range.end, range.start)
        }
    }

    /// Recompute after the editor mutates its source, preserving only an
    /// unfinished typing range. A pasted or explicitly replaced token is an
    /// atom immediately, without a JS event/prop round trip.
    pub fn edited(&mut self, text: &str, edit: &Range<usize>, inserted: usize, kind: TokenEdit) {
        let pending = self.pending.clone();
        let touching_atom = self
            .spans
            .iter()
            .any(|s| self.atom(s) && s.range.start < edit.start && edit.start <= s.range.end);
        self.scan(text);
        self.pending = match kind {
            TokenEdit::Typing if !touching_atom => {
                let caret = edit.start + inserted;
                self.spans
                    .iter()
                    .find(|s| {
                        s.range.start < caret && caret <= s.range.end && s.range.start <= edit.start
                    })
                    .map(|s| s.range.clone())
            }
            TokenEdit::Delete => pending.and_then(|range| {
                let map = |at: usize| {
                    if at <= edit.start {
                        at
                    } else if at >= edit.end {
                        edit.start + inserted + at - edit.end
                    } else {
                        edit.start + inserted
                    }
                };
                let range = map(range.start)..map(range.end);
                self.spans
                    .iter()
                    .find(|s| s.range == range)
                    .map(|s| s.range.clone())
            }),
            _ => None,
        };
    }
}
