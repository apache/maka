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

//! Resume only the requested visual window under the shared frame allowance.
use super::*;
use std::ops::Range;
impl State {
    fn covers(&self, rows: &Range<usize>) -> bool {
        !self.committed.is_empty()
            && self.origin() <= rows.start
            && self.origin() + self.lines().len() >= rows.end.min(self.rows().unwrap_or(usize::MAX))
    }
    pub fn advance(&mut self, width: u16, request: Request) -> Result<bool, &'static str> {
        let Some(document) = &self.document else {
            return Ok(false);
        };
        if self.width != width || self.cursor.is_none() {
            self.width = width;
            self.committed = vec![];
            self.committed_bytes = 0;
            self.committed_origin = 0;
            self.cursor = Some(document.cursor(width, 0..0));
            self.request = None;
            self.ready = false;
            self.measured = 0;
            self.advanced = None;
            self.located = None;
        }
        if let Request::Rows(rows) = &request
            && self.covers(rows)
        {
            return Ok(true);
        }
        if self.request.as_ref() != Some(&request) {
            // A logical byte identifies one semantic position. Source ranges can
            // occur repeatedly, so global source searches keep their canonical order.
            let known = (!self.committed.is_empty())
                .then(|| match &request {
                    Request::Logical {
                        offset,
                        before,
                        rows,
                    } => self
                        .lines()
                        .iter()
                        .position(|line| {
                            line.mapping.iter().any(|span| {
                                span.logical.contains(offset) || span.logical.end == *offset
                            })
                        })
                        .map(|line| (self.origin() + line, *before, *rows)),
                    _ => None,
                })
                .flatten();
            self.located = known.map(|(row, _, _)| row);
            if let Some((row, before, rows)) = known {
                let start = row.saturating_sub(before);
                let window = start..start.saturating_add(rows);
                if self.covers(&window) {
                    return Ok(true);
                }
                self.cursor.as_mut().unwrap().request(window);
            } else {
                let cursor = self.cursor.as_mut().unwrap();
                match &request {
                    Request::Rows(rows) => cursor.request(rows.clone()),
                    Request::Tail(rows) => cursor.request_tail(*rows),
                    Request::Source {
                        source,
                        before,
                        rows,
                    } => cursor.request_source(source.clone(), *before, *rows),
                    Request::Logical {
                        offset,
                        before,
                        rows,
                    } => cursor.request_logical(*offset, *before, *rows),
                }
            }
            self.request = Some(request);
            self.ready = false;
        }
        if self.ready {
            return Ok(true);
        }
        if self.advanced == Some(frame_work::id()) {
            return Ok(false);
        }
        let cursor = self.cursor.as_mut().unwrap();
        let allowance = frame_work::allowance(cursor.minimum_work());
        if allowance == 0 {
            return Ok(false);
        }
        self.advanced = Some(frame_work::id());
        let progress = cursor.advance(allowance)?;
        frame_work::charge(progress.work);
        self.measured = self.measured.max(progress.measured_rows);
        self.ready = progress.window_ready && !matches!(cursor.seek_status(), SeekStatus::Pending);
        if self.ready {
            self.committed = cursor.lines().to_vec();
            self.committed_origin = cursor.origin();
            self.committed_bytes = self.committed.capacity()
                * std::mem::size_of::<layout::VisualLine>()
                + self
                    .committed
                    .iter()
                    .map(|line| {
                        line.mapping.capacity() * std::mem::size_of::<layout::SourceSpan>()
                            + line.line.spans.capacity()
                                * std::mem::size_of::<ratatui::text::Span<'static>>()
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
        }
        Ok(self.ready)
    }
}
