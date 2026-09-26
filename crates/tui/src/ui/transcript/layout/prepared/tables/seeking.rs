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
impl State {
    pub(super) fn seek(
        &mut self,
        writer: &mut Writer,
        budget: usize,
        progress: &mut Progress,
    ) -> Result<bool, &'static str> {
        let before = progress.work;
        while self.seek_at < self.table.cells.len() {
            if progress.work - before >= budget {
                return Ok(false);
            }
            let index = self.seek_at;
            let cell = &self.table.cells[index];
            if self.seeking.is_none() {
                let Some(probe) = writer
                    .probe
                    .as_ref()
                    .unwrap()
                    .cell(cell.logical, cell.document.text().len())
                else {
                    self.seek_at += 1;
                    progress.work += 1;
                    continue;
                };
                let mut cursor = self.take(index);
                cursor.begin_probe(probe);
                self.seeking = Some(cursor);
            }
            let cursor = self.seeking.as_mut().unwrap();
            let step = cursor.advance(budget.saturating_sub(progress.work - before))?;
            progress.work += step.work;
            progress.bytes += step.bytes;
            let probe = cursor.writer.probe.as_ref().unwrap();
            if !step.complete && probe.found.is_none() {
                return Ok(false);
            }
            let cursor = self.seeking.take().unwrap();
            let probe = cursor.writer.probe.as_ref().unwrap();
            if let Some(row) = probe.found {
                let row = self.cell_row(index, row);
                self.seek_found = Some(self.seek_found.map_or(row, |old| old.min(row)));
            }
            if let Some((source, row)) = probe.fallback {
                let row = self.cell_row(index, row);
                if self.seek_fallback.is_none_or(|(old, _)| source > old) {
                    self.seek_fallback = Some((source, row));
                }
            }
            let cell = &self.table.cells[index];
            if cell.document.text().is_empty()
                && matches!(probe.target, super::super::seeking::Target::Logical { .. })
            {
                let row = self.cell_row(index, 0);
                self.seek_found = Some(self.seek_found.map_or(row, |old| old.min(row)));
            }
            if cell.empty {
                let mut fallback = writer.probe.as_ref().unwrap().clone();
                fallback.fallback = self.seek_fallback;
                fallback.anchor(cell.source, self.cell_row(index, 0));
                self.seek_fallback = fallback.fallback;
            }
            self.keep(index, cursor);
            self.seek_at += 1;
        }
        let probe = writer.probe.as_mut().unwrap();
        if let Some(row) = self.seek_found {
            let row = writer.rows + row;
            probe.found = Some(probe.found.map_or(row, |old| old.min(row)));
        }
        if let Some((source, row)) = self.seek_fallback
            && probe.fallback.is_none_or(|(old, _)| source > old)
        {
            probe.fallback = Some((source, writer.rows + row));
        }
        self.seek_done = true;
        Ok(true)
    }
    fn cell_row(&self, index: usize, y: usize) -> usize {
        let columns = self.table.columns;
        let row = index / columns;
        let column = index % columns;
        if !self.stacked {
            return self.starts[row] + y;
        }
        if self.table.cells.len() == columns {
            return self.heights[..column].iter().sum::<usize>() + y;
        }
        let shown_row = row.max(1);
        let previous = (0..column)
            .map(|col| self.heights[col] + self.heights[shown_row * columns + col])
            .sum::<usize>();
        self.starts[shown_row]
            + previous
            + if row == 0 {
                y
            } else {
                self.heights[column] + y
            }
    }
}
