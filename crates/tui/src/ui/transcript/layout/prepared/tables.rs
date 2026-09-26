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

//! Tables retain semantic cells; width measurement and window emission are resumable.
mod measure;
mod seeking;
mod window;
use super::*;
use pulldown_cmark::Alignment;
use std::collections::BTreeMap;

pub(in super::super) struct Cell {
    document: Document,
    source: usize,
    logical: usize,
    empty: bool,
}
pub(in super::super) struct Table {
    cells: Vec<Cell>,
    columns: usize,
    align: Vec<Alignment>,
    ascii: bool,
    indent: usize,
    logical_end: usize,
    logical_line: bool,
    logical_nonempty: bool,
}
impl Table {
    pub(super) fn max_grapheme(&self) -> usize {
        self.cells
            .iter()
            .map(|cell| cell.document.max_grapheme)
            .max()
            .unwrap_or(1)
    }
    pub(super) fn bytes(&self) -> usize {
        self.cells.capacity() * std::mem::size_of::<Cell>()
            + self.align.capacity() * std::mem::size_of::<Alignment>()
            + self
                .cells
                .iter()
                .map(|cell| cell.document.bytes())
                .sum::<usize>()
    }
}
pub(in super::super) fn prepare(
    writer: &mut Writer,
    source: &str,
    rows: Vec<Vec<super::super::table::Cell<'_>>>,
    align: Vec<Alignment>,
    ascii: bool,
) -> Result<(), &'static str> {
    writer.boundary()?;
    let columns = align.len();
    let mut cells = Vec::new();
    for (row, values) in rows.into_iter().enumerate() {
        for (column, cell) in values.into_iter().enumerate() {
            writer.append_logical(if column > 0 {
                "\t"
            } else if row > 0 {
                "\n"
            } else {
                ""
            });
            let logical = writer.logical_len;
            let empty = cell.events.is_empty();
            let document = Document::events(source, cell.events, ascii, writer.colors)?;
            writer.append_logical(document.text());
            cells.push(Cell {
                document,
                source: cell.source,
                logical,
                empty,
            });
        }
    }
    writer.push_operation(Operation::Table(Arc::new(Table {
        cells,
        columns,
        align,
        ascii,
        indent: writer.indent,
        logical_end: writer.logical_len,
        logical_line: writer.logical_line,
        logical_nonempty: writer.logical_nonempty,
    })))?;
    writer.logical("\n");
    writer.gap()
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Preferred,
    Measure,
    Ready,
}
pub(super) struct State {
    table: Arc<Table>,
    width: usize,
    indent: usize,
    phase: Phase,
    at: usize,
    active: Option<Cursor>,
    preferred: Vec<usize>,
    widths: Vec<usize>,
    stacked: bool,
    heights: Vec<usize>,
    sources: Vec<usize>,
    starts: Vec<usize>,
    row_max: usize,
    cache: BTreeMap<usize, Cursor>,
    cache_bytes: usize,
    window: Range<usize>,
    next: usize,
    request: Option<window::Request>,
    seek_at: usize,
    seeking: Option<Cursor>,
    seek_found: Option<usize>,
    seek_fallback: Option<(usize, usize)>,
    seek_done: bool,
}
impl State {
    pub(super) fn new(table: Arc<Table>, width: usize) -> Self {
        let indent = table.indent.min(width.saturating_sub(1));
        let width = width - indent;
        let columns = table.columns;
        let stacked = width < columns + (columns - 1) * 3;
        let available = width.saturating_sub((columns - 1) * 3).max(1);
        Self {
            table,
            width,
            indent,
            phase: if stacked {
                Phase::Measure
            } else {
                Phase::Preferred
            },
            at: 0,
            active: None,
            preferred: vec![1; columns],
            widths: vec![if stacked { width } else { available }; columns],
            stacked,
            heights: Vec::new(),
            sources: Vec::new(),
            starts: vec![0],
            row_max: 0,
            cache: BTreeMap::new(),
            cache_bytes: 0,
            window: 0..0,
            next: 0,
            request: None,
            seek_at: 0,
            seeking: None,
            seek_found: None,
            seek_fallback: None,
            seek_done: false,
        }
    }
    pub(super) fn begin(&mut self, window: Range<usize>) {
        self.next = window.start;
        self.window = window;
        self.request = None;
        self.seek_at = 0;
        self.seeking = None;
        self.seek_found = None;
        self.seek_fallback = None;
        self.seek_done = false;
    }
    pub(super) fn advance(
        &mut self,
        writer: &mut Writer,
        budget: usize,
    ) -> Result<Progress, &'static str> {
        let mut progress = Progress::default();
        while progress.work < budget && self.phase != Phase::Ready {
            if !self.measure(budget - progress.work, &mut progress)? {
                return Ok(progress);
            }
        }
        if self.phase != Phase::Ready {
            return Ok(progress);
        }
        if writer.probe.is_some()
            && !self.seek_done
            && !self.seek(writer, budget - progress.work, &mut progress)?
        {
            return Ok(progress);
        }
        while self.next < self.window.end.min(self.height()) {
            if budget == progress.work {
                return Ok(progress);
            }
            if !self.emit(writer, budget - progress.work, &mut progress)? {
                return Ok(progress);
            }
        }
        progress.complete = true;
        Ok(progress)
    }
    pub(super) fn finish(&self, writer: &mut Writer) {
        let height = self.height();
        writer.rows += height;
        writer.last_nonempty =
            !self.stacked || self.table.cells.len() == self.table.columns || self.indent > 0;
        writer.solid_rows = writer
            .rows
            .saturating_sub(usize::from(!writer.last_nonempty));
        let last_row = self.table.cells.len() / self.table.columns - 1;
        writer.last_source = if self.stacked {
            self.table.cells.last().unwrap().source
        } else if last_row == 0 {
            self.table.cells[self.table.columns - 1].source
        } else {
            let start = last_row * self.table.columns;
            let height = self.heights[start..].iter().copied().max().unwrap();
            self.sources[start
                + self.heights[start..]
                    .iter()
                    .position(|value| *value == height)
                    .unwrap()]
        };
        writer.logical_len = self.table.logical_end;
        writer.logical_line = self.table.logical_line;
        writer.logical_nonempty = self.table.logical_nonempty;
    }
    fn height(&self) -> usize {
        *self.starts.last().unwrap()
    }
    fn keep(&mut self, index: usize, cursor: Cursor) {
        self.cache_bytes += cursor.retained_bytes() + std::mem::size_of::<Cursor>();
        self.cache.insert(index, cursor);
        while self.cache_bytes > 8 * 1024 * 1024 && self.cache.len() > 1 {
            let (_, cursor) = self.cache.pop_first().unwrap();
            self.cache_bytes -= cursor.retained_bytes() + std::mem::size_of::<Cursor>();
        }
    }
    fn take(&mut self, index: usize) -> Cursor {
        if let Some(cursor) = self.cache.remove(&index) {
            self.cache_bytes -= cursor.retained_bytes() + std::mem::size_of::<Cursor>();
            cursor
        } else {
            self.table.cells[index]
                .document
                .cursor(self.widths[index % self.table.columns] as u16, 0..0)
        }
    }
    pub(super) fn retained_bytes(&self) -> usize {
        self.cache_bytes
            + self.seeking.as_ref().map_or(0, Cursor::retained_bytes)
            + self.active.as_ref().map_or(0, Cursor::retained_bytes)
            + (self.preferred.capacity()
                + self.widths.capacity()
                + self.heights.capacity()
                + self.sources.capacity()
                + self.starts.capacity())
                * std::mem::size_of::<usize>()
            + self.request.as_ref().map_or(0, window::Request::bytes)
    }
}
