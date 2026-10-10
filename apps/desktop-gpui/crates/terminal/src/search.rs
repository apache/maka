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

//! Finding a literal in a terminal's grid and scrollback, for the
//! terminal view's find bar (the `search` crate's `Searchable`). The text is
//! read under the emulator's lock and searched after it is released, both
//! off the main thread.

use std::ops::Range;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::Flags;
use search::SearchQuery;
use search::matching::find_ranges;

use crate::emulator::Listener;

/// One occurrence of a query: from its first cell to its last, both
/// included, in grid coordinates (line 0 is the top of the screen, negative
/// lines are scrollback). A match may continue over a wrapped line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct TerminalMatch {
    pub start: Point,
    pub end: Point,
}

/// A line as the program wrote it: rows joined where they wrapped, with the
/// cell each character of its text came from.
#[derive(Debug, Default)]
struct LogicalLine {
    text: String,
    /// For each character of `text`, its byte offset and its cell.
    cells: Vec<(usize, Point)>,
}

impl LogicalLine {
    fn push(&mut self, c: char, point: Point) {
        self.cells.push((self.text.len(), point));
        self.text.push(c);
    }

    /// Drops the blank cells the line ends with.
    fn trim_end(&mut self) {
        let trimmed = self.text.trim_end_matches(' ').len();
        self.text.truncate(trimmed);
        self.cells.retain(|(offset, _)| *offset < trimmed);
    }

    /// The cell of the character the byte `offset` belongs to.
    fn cell_at(&self, offset: usize) -> Point {
        let index = self.cells.partition_point(|(start, _)| *start <= offset);
        self.cells[index.saturating_sub(1)].1
    }

    fn matches(&self, query: &SearchQuery) -> impl Iterator<Item = TerminalMatch> + '_ {
        find_ranges(&self.text, query).into_iter().map(|Range { start, end }| TerminalMatch {
            start: self.cell_at(start),
            end: self.cell_at(end - 1),
        })
    }
}

/// The text of a whole grid, scrollback first.
#[derive(Debug, Default)]
pub(crate) struct GridText {
    lines: Vec<LogicalLine>,
}

impl GridText {
    pub(crate) fn of(term: &Term<Listener>) -> Self {
        let grid = term.grid();
        let columns = grid.columns();
        let mut lines = Vec::new();
        let mut line = LogicalLine::default();
        for row_index in grid.topmost_line().0..=grid.bottommost_line().0 {
            let row = &grid[Line(row_index)];
            for column in 0..columns {
                let cell = &row[Column(column)];
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let point = Point::new(Line(row_index), Column(column));
                line.push(cell.c, point);
                for &zero_width in cell.zerowidth().unwrap_or_default() {
                    line.push(zero_width, point);
                }
            }
            let wrapped = columns > 0 && row[Column(columns - 1)].flags.contains(Flags::WRAPLINE);
            if !wrapped {
                line.trim_end();
                lines.push(std::mem::take(&mut line));
            }
        }
        if !line.text.is_empty() {
            line.trim_end();
            lines.push(line);
        }
        Self { lines }
    }

    /// Every match of `query`, top to bottom.
    pub(crate) fn find(&self, query: &SearchQuery) -> Vec<TerminalMatch> {
        if query.is_empty() {
            return Vec::new();
        }
        self.lines.iter().flat_map(|line| line.matches(query)).collect()
    }
}

#[cfg(test)]
mod tests {
    use host_protocol::PtySize;
    use search::SearchOptions;

    use super::*;
    use crate::emulator::Emulator;

    fn point(line: i32, column: usize) -> Point {
        Point::new(Line(line), Column(column))
    }

    #[test]
    fn a_word_is_found_in_the_scrollback_and_across_a_wrap() {
        let mut emulator = Emulator::new(PtySize::new(10, 3).expect("size"));
        // "needle" scrolls into the scrollback; "wrapped" wraps after 10
        // columns; a wide character takes two cells.
        emulator.advance("needle\r\n1\r\n2\r\n3\r\nxxxxwrapped\r\n中needle");
        let text = GridText::of(emulator.term());
        let query = SearchQuery::new("needle", SearchOptions::new());
        assert_eq!(
            text.find(&query),
            [
                TerminalMatch { start: point(-4, 0), end: point(-4, 5) },
                TerminalMatch { start: point(2, 2), end: point(2, 7) },
            ]
        );
        let wrapped = SearchQuery::new("wrapped", SearchOptions::new());
        assert_eq!(text.find(&wrapped), [TerminalMatch { start: point(0, 4), end: point(1, 0) }]);
        let cased = SearchQuery::new("NEEDLE", SearchOptions::new().case_sensitive(true));
        assert!(text.find(&cased).is_empty());
        let word = SearchQuery::new("need", SearchOptions::new().whole_word(true));
        assert!(text.find(&word).is_empty());
    }
}
