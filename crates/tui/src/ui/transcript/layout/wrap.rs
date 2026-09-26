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

//! The shared resumable grapheme step used by eager and windowed layout.
use super::*;

pub(super) struct Step {
    pub consumed: usize,
    pub inspected: usize,
}
impl Writer {
    pub(super) fn step(
        &mut self,
        text: &str,
        offset: usize,
        source: &Range<usize>,
        exact: bool,
        semantic: bool,
        budget: usize,
    ) -> Result<Step, &'static str> {
        if self.bytes > MAX_BYTES {
            return Err("Transcript layout exceeds local capacity");
        }
        let grapheme = text[offset..].graphemes(true).next().expect("nonempty run");
        let mut inspected = grapheme.len();
        let position = if exact {
            source.start + offset
        } else {
            source.start
        };
        if matches!(grapheme, "\n" | "\r\n") {
            self.source.get_or_insert(position);
            if semantic {
                self.logical("\n");
            }
            self.flush()?;
            return Ok(Step {
                consumed: grapheme.len(),
                inspected,
            });
        }
        let safe = if grapheme == "\t" {
            " ".repeat(4 - self.cells % 4)
        } else {
            crate::view::safe(grapheme)
        };
        let width = safe.width();
        let space = matches!(grapheme, " " | "\t");
        if semantic && space && self.cells + width > self.width && self.cells > 0 {
            self.flush()?;
            self.logical(grapheme);
            return Ok(Step {
                consumed: grapheme.len(),
                inspected,
            });
        }
        if self.word_wrap && semantic && self.word_break && !space && width == 1 {
            // Continue the same lookahead across budget yields without changing a wrap.
            let remaining = self.width.saturating_sub(self.cells);
            let (mut at, mut word) = self
                .lookahead
                .take()
                .unwrap_or((offset + grapheme.len(), 1));
            while word <= remaining && at < text.len() {
                // Preparation bounds graphemes; reserve enough before scanning the next one.
                if budget.saturating_sub(inspected) < self.max_grapheme {
                    self.lookahead = Some((at, word));
                    return Ok(Step {
                        consumed: 0,
                        inspected,
                    });
                }
                let next = text[at..].graphemes(true).next().unwrap();
                inspected += next.len();
                if matches!(next, " " | "\t" | "\n" | "\r" | "\r\n")
                    || crate::view::safe(next).width() != 1
                {
                    break;
                }
                word += 1;
                at += next.len();
            }
            if word > remaining {
                self.flush()?;
                return Ok(Step {
                    consumed: 0,
                    inspected,
                });
            }
        }
        if self.cells + width > self.width && self.cells > 0 {
            self.flush()?;
            return Ok(Step {
                consumed: 0,
                inspected,
            });
        }
        if !self.nonempty && self.indent > 0 {
            let indent = self.indent.min(self.width.saturating_sub(width.max(1)));
            self.span(&" ".repeat(indent));
            self.cells = indent;
        }
        self.source.get_or_insert(position);
        let logical = self.logical_len;
        if semantic {
            self.logical(if grapheme == "\t" { "\t" } else { &safe });
        }
        let logical = logical..self.logical_len;
        let mapped = if exact {
            position..position + grapheme.len()
        } else {
            source.clone()
        };
        if width > self.width {
            self.mapped_span("?", mapped, false, logical);
            self.cells += 1;
        } else {
            self.mapped_span(&safe, mapped, exact && safe == grapheme, logical);
            self.cells += width;
        }
        self.word_break = semantic && (space || width > 1);
        Ok(Step {
            consumed: grapheme.len(),
            inspected,
        })
    }
}
