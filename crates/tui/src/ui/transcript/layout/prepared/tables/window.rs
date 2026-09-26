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

pub(super) struct Request {
    row: usize,
    y: usize,
    units: Vec<(usize, usize, Option<usize>)>,
    contents: Vec<Option<VisualLine>>,
    at: usize,
    cursor: Option<Cursor>,
    fixed: Option<VisualLine>,
}
impl Request {
    pub(super) fn bytes(&self) -> usize {
        self.units.capacity() * std::mem::size_of::<(usize, usize, Option<usize>)>()
            + self.contents.capacity() * std::mem::size_of::<Option<VisualLine>>()
            + self.cursor.as_ref().map_or(0, Cursor::retained_bytes)
            + self
                .contents
                .iter()
                .flatten()
                .map(|line| {
                    line.line.spans.capacity() * std::mem::size_of::<Span<'static>>()
                        + line.mapping.capacity() * std::mem::size_of::<SourceSpan>()
                        + line
                            .line
                            .spans
                            .iter()
                            .map(|span| span.content.len())
                            .sum::<usize>()
                })
                .sum::<usize>()
    }
}
impl State {
    pub(super) fn emit(
        &mut self,
        writer: &mut Writer,
        budget: usize,
        progress: &mut Progress,
    ) -> Result<bool, &'static str> {
        let mut request = self.request.take().unwrap_or_else(|| self.row_request());
        let before = progress.work;
        while request.at < request.units.len() {
            let (index, y, repeated) = request.units[request.at];
            if y >= self.heights[index] {
                request.contents.push(None);
                request.at += 1;
                progress.work += 1;
            } else {
                if request.cursor.is_none() {
                    let mut cursor = self.take(index);
                    cursor.request(y..y + 1);
                    request.cursor = Some(cursor);
                }
                let cursor = request.cursor.as_mut().unwrap();
                let step = cursor.advance(budget.saturating_sub(progress.work - before))?;
                progress.work += step.work;
                progress.bytes += step.bytes;
                if !step.window_ready {
                    self.request = Some(request);
                    return Ok(false);
                }
                let cursor = request.cursor.take().unwrap();
                let mut line = cursor.lines().first().cloned().expect("ready cell row");
                let cell = &self.table.cells[index];
                if cell.empty {
                    line.source = cell.source;
                }
                for span in &mut line.mapping {
                    span.logical.start += cell.logical;
                    span.logical.end += cell.logical;
                }
                if let Some(source) = repeated {
                    line.source = source;
                    line.mapping.clear();
                    line.line = line.line.patch_style(
                        Style::default()
                            .fg(writer.colors.accent)
                            .add_modifier(Modifier::BOLD),
                    );
                }
                request.contents.push(Some(line));
                request.at += 1;
                self.keep(index, cursor);
            }
            if progress.work - before >= budget {
                self.request = Some(request);
                return Ok(false);
            }
        }
        let mut line = if let Some(line) = request.fixed.take() {
            line
        } else if self.stacked {
            request.contents.pop().flatten().unwrap()
        } else {
            let contents: Vec<_> = request.contents.iter().map(Option::as_ref).collect();
            super::super::super::table::grid_line(
                &contents,
                &self.widths,
                &self.table.align,
                request.row == 0,
                self.table.cells[request.row * self.table.columns].source,
                self.table.ascii,
                writer.colors,
            )
        };
        if self.indent > 0 {
            line.line
                .spans
                .insert(0, Span::raw(" ".repeat(self.indent)));
            for span in &mut line.mapping {
                span.display.start += self.indent;
                span.display.end += self.indent;
            }
        }
        writer.bytes += std::mem::size_of::<VisualLine>()
            + line.mapping.len() * std::mem::size_of::<SourceSpan>()
            + line
                .line
                .spans
                .iter()
                .map(|span| span.content.len() + std::mem::size_of::<Span<'static>>())
                .sum::<usize>();
        if writer.bytes > MAX_BYTES || writer.lines.len() >= MAX_LINES {
            return Err("Transcript layout exceeds local capacity");
        }
        writer.lines.push(line);
        self.next += 1;
        progress.work += 1;
        Ok(true)
    }
    fn row_request(&self) -> Request {
        let row = self
            .starts
            .partition_point(|start| *start <= self.next)
            .saturating_sub(1);
        let y = self.next - self.starts[row];
        let columns = self.table.columns;
        let mut request = Request {
            row,
            y,
            units: Vec::new(),
            contents: Vec::new(),
            at: 0,
            cursor: None,
            fixed: None,
        };
        if !self.stacked {
            if row == 0 && y == self.starts[1] - 1 {
                let text = self
                    .widths
                    .iter()
                    .map(|width| if self.table.ascii { "-" } else { "─" }.repeat(*width))
                    .collect::<Vec<_>>()
                    .join(if self.table.ascii { "-+-" } else { "─┼─" });
                request.fixed = Some(VisualLine {
                    line: Line::styled(
                        text,
                        Style::default().fg(self.table.cells[0].document.colors.subtle),
                    ),
                    source: self.table.cells[columns - 1].source,
                    mapping: vec![],
                });
            } else {
                for column in 0..columns {
                    request.units.push((row * columns + column, y, None));
                }
            }
            return request;
        }
        let mut y = request.y;
        for column in 0..columns {
            if row > 0 {
                if y < self.heights[column] {
                    request.units.push((
                        column,
                        y,
                        Some(self.table.cells[row * columns + column].source),
                    ));
                    return request;
                }
                y -= self.heights[column];
            }
            let index = row * columns + column;
            if y < self.heights[index] {
                request.units.push((index, y, None));
                return request;
            }
            y -= self.heights[index];
        }
        request.fixed = Some(VisualLine {
            line: Line::default(),
            source: self.table.cells[(row + 1) * columns - 1].source,
            mapping: vec![],
        });
        request
    }
}
