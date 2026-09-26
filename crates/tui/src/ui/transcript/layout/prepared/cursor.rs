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

mod checkpoints;
mod seeking;
use super::operations::BandKind;
use super::*;

/// Work counts inspected input bytes (including lookahead) and control operations.
/// Bytes counts consumed run bytes; preparation bounds indivisible graphemes.
#[derive(Debug, Default)]
pub struct Progress {
    pub work: usize,
    pub bytes: usize,
    pub measured_rows: usize,
    pub complete: bool,
    pub window_ready: bool,
}
#[derive(Clone)]
struct Checkpoint {
    operation: usize,
    offset: usize,
    label: bool,
    width: usize,
    indent: usize,
    rows: usize,
    solid_rows: usize,
    last_source: usize,
    last_nonempty: bool,
    logical_line: bool,
    logical_nonempty: bool,
    logical_len: usize,
    style: Style,
    word_wrap: bool,
    band: Option<Band>,
}
pub struct Cursor {
    document: Document,
    pub(super) writer: Writer,
    window: Range<usize>,
    operation: usize,
    offset: usize,
    label: bool,
    checkpoints: Vec<Checkpoint>,
    stride: usize,
    complete: bool,
    tables: std::collections::HashMap<usize, tables::State>,
    active_table: Option<usize>,
    height: Option<usize>,
    seek: Option<super::seeking::Seek>,
    seek_status: SeekStatus,
}
impl Cursor {
    pub(super) fn new(document: Document, width: u16, window: Range<usize>) -> Self {
        let mut writer = Writer::new(width);
        writer.colors = document.colors;
        writer.max_grapheme = document.max_grapheme;
        writer.window = Some(window.clone());
        writer.retain_text = false;
        let mut cursor = Self {
            document,
            writer,
            window,
            operation: 0,
            offset: 0,
            label: false,
            checkpoints: Vec::new(),
            stride: 128,
            complete: false,
            tables: Default::default(),
            active_table: None,
            height: None,
            seek: None,
            seek_status: SeekStatus::Idle,
        };
        cursor.checkpoint();
        cursor
    }
    #[cfg(test)]
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn origin(&self) -> usize {
        self.window.start
    }
    pub fn lines(&self) -> &[VisualLine] {
        &self.writer.lines
    }
    pub fn total_rows(&self) -> Option<usize> {
        self.height
    }
    pub fn minimum_work(&self) -> usize {
        self.document.max_grapheme * 2
    }
    pub fn retained_bytes(&self) -> usize {
        let line_bytes = |line: &Line<'static>, mapping: &Vec<SourceSpan>| {
            line.spans.capacity() * std::mem::size_of::<Span<'static>>()
                + line
                    .spans
                    .iter()
                    .map(|span| match &span.content {
                        std::borrow::Cow::Owned(text) => text.capacity(),
                        _ => 0,
                    })
                    .sum::<usize>()
                + mapping.capacity() * std::mem::size_of::<SourceSpan>()
        };
        self.tables
            .values()
            .map(tables::State::retained_bytes)
            .sum::<usize>()
            + self.checkpoints.capacity() * std::mem::size_of::<Checkpoint>()
            + self.writer.lines.capacity() * std::mem::size_of::<VisualLine>()
            + self
                .writer
                .lines
                .iter()
                .map(|line| line_bytes(&line.line, &line.mapping))
                .sum::<usize>()
            + line_bytes(&self.writer.line, &self.writer.mapping)
    }
    /// Reuse the closest bounded checkpoint. Evicted rows never become EOF.
    pub fn request(&mut self, window: Range<usize>) {
        self.seek = None;
        self.seek_status = SeekStatus::Idle;
        self.writer.probe = None;
        self.request_window(window);
    }
    fn request_window(&mut self, window: Range<usize>) {
        if self.window == window {
            return;
        }
        let checkpoint = self
            .checkpoints
            .iter()
            .rev()
            .find(|point| point.rows <= window.start)
            .unwrap()
            .clone();
        self.window = window;
        self.restore(checkpoint);
    }
    pub fn advance(&mut self, budget: usize) -> Result<Progress, &'static str> {
        let mut progress = Progress::default();
        let operations = self.document.operations.clone();
        while !self.complete && progress.work < budget {
            if self.operation == operations.len() {
                if self.writer.rows == 0 {
                    self.writer.flush()?;
                }
                self.complete = true;
                self.height = Some(self.writer.solid_rows.max(1));
                if self.writer.solid_rows == 0 {
                    self.writer.lines.clear();
                    if self.window.contains(&0) {
                        self.writer.lines.push(VisualLine {
                            line: Line::default(),
                            source: self.writer.last_source,
                            mapping: vec![],
                        });
                    }
                }
                self.writer.lines.truncate(
                    self.writer
                        .solid_rows
                        .max(1)
                        .saturating_sub(self.window.start),
                );
                break;
            }
            let operation = &operations[self.operation];
            if let Operation::Table(table) = operation {
                let state = self
                    .tables
                    .entry(self.operation)
                    .or_insert_with(|| tables::State::new(table.clone(), self.writer.width));
                if self.active_table != Some(self.operation) {
                    state.begin(
                        self.window.start.saturating_sub(self.writer.rows)
                            ..self.window.end.saturating_sub(self.writer.rows),
                    );
                    self.active_table = Some(self.operation);
                }
                let step = state.advance(&mut self.writer, budget - progress.work)?;
                progress.work += step.work;
                progress.bytes += step.bytes;
                if !step.complete {
                    break;
                }
                state.finish(&mut self.writer);
                if step.work == 0 {
                    progress.work += 1;
                }
                self.operation += 1;
                self.active_table = None;
                if self.writer.rows >= self.checkpoints.last().unwrap().rows + self.stride {
                    self.checkpoint();
                }
                continue;
            }
            let run = match operation {
                Operation::Write(run) => Some(run),
                _ => None,
            };
            let label = match operation {
                Operation::FenceStart { info, .. } if self.label => Some(info.as_ref()),
                _ => None,
            };
            if run.is_some() || label.is_some() {
                if budget - progress.work < self.document.max_grapheme {
                    break;
                }
                let (text, source, exact, semantic) = if let Some(run) = run {
                    self.writer.style = run.style;
                    // Panels remove the surrounding list indentation from body rows.
                    self.writer.indent = if matches!(
                        self.writer.band.as_ref().map(|band| &band.kind),
                        Some(BandKind::Fence { .. })
                    ) {
                        0
                    } else {
                        run.indent
                    };
                    self.writer.word_wrap = run.word_wrap;
                    (
                        run.text.as_str(),
                        run.source.clone(),
                        run.exact,
                        run.semantic,
                    )
                } else {
                    let Operation::FenceStart { start, .. } = operation else {
                        unreachable!()
                    };
                    self.writer.style = Style::default().fg(self.document.colors.subtle);
                    (label.unwrap(), *start..*start, false, false)
                };
                if self.offset < text.len() {
                    let step = self.writer.step(
                        text,
                        self.offset,
                        &source,
                        exact,
                        semantic,
                        budget - progress.work,
                    )?;
                    self.offset += step.consumed;
                    progress.work += step.inspected;
                    progress.bytes += step.consumed;
                }
                if self.offset == text.len() {
                    if self.label {
                        self.writer.flush()?;
                        self.writer.logical_line = false;
                    }
                    self.label = false;
                    self.operation += 1;
                    self.offset = 0;
                }
            } else {
                progress.work += 1;
                match operation {
                    Operation::Boundary => self.writer.boundary()?,
                    Operation::Gap => self.writer.gap()?,
                    Operation::Flush => self.writer.flush()?,
                    Operation::Logical(text) => self.writer.logical(text),
                    Operation::FenceStart {
                        info,
                        start,
                        indent,
                        ascii,
                    } => {
                        let width = self.writer.width;
                        self.writer.indent = *indent;
                        let indent = (*indent).min(width.saturating_sub(1));
                        if width.saturating_sub(indent) >= 8 {
                            let colors = self.document.colors;
                            let base = colors.base().bg(colors.panel());
                            let (bar, bar_style) = if colors.terminal {
                                (if *ascii { "| " } else { "│ " }, base.fg(colors.border))
                            } else {
                                (" ", base)
                            };
                            self.writer.band = Some(Band {
                                outer_width: width,
                                outer_indent: indent,
                                first: self.writer.rows,
                                anchor: *start,
                                kind: BandKind::Fence {
                                    base,
                                    bar,
                                    bar_style,
                                },
                            });
                            self.writer.width = width - indent - 2;
                            self.writer.indent = 0;
                        } else if !info.is_empty() {
                            self.label = true;
                        }
                    }
                    Operation::FenceEnd => {
                        if self.writer.band.is_some() {
                            self.writer.boundary()?;
                            let band = self.writer.band.as_ref().unwrap();
                            if self.writer.rows == band.first {
                                self.writer.source = Some(band.anchor);
                                self.writer.flush()?;
                            }
                            self.end_band();
                        }
                    }
                    Operation::DiffStart {
                        marker,
                        color,
                        base,
                    } => {
                        let width = self.writer.width;
                        let gutter = if width >= 4 { 2 } else { 0 };
                        self.writer.band = Some(Band {
                            outer_width: width,
                            outer_indent: self.writer.indent,
                            first: self.writer.rows,
                            anchor: 0,
                            kind: BandKind::Diff {
                                base: *base,
                                marker,
                                color: *color,
                                gutter,
                            },
                        });
                        self.writer.width -= gutter;
                    }
                    Operation::DiffEnd => self.end_band(),
                    Operation::Write(_) | Operation::Table(_) => unreachable!(),
                }
                if !self.label {
                    self.operation += 1;
                }
            }
            if !self.writer.nonempty
                && self.writer.rows >= self.checkpoints.last().unwrap().rows + self.stride
            {
                self.checkpoint();
            }
        }
        self.update_seek();
        progress.measured_rows = self.writer.rows;
        progress.complete = self.complete;
        progress.window_ready = if self.seek.is_some() {
            matches!(self.seek_status, SeekStatus::Ready { .. })
        } else {
            self.complete || self.writer.solid_rows >= self.window.end
        };
        Ok(progress)
    }
    fn end_band(&mut self) {
        if let Some(band) = self.writer.band.take() {
            self.writer.width = band.outer_width;
            self.writer.indent = band.outer_indent;
        }
    }
}
