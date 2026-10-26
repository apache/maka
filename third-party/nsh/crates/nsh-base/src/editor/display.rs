//! The display map: how the text is laid out in display rows. Tabs advance
//! to the next tab stop, widths come from the editor's font (measured once
//! per character and cached), long lines soft-wrap at a width, and a folded
//! range shows as its first line alone.
//!
//! Rows are kept in one vector with the first row of every line beside it,
//! so line → row is an index and row → line a field; an edit lays out only
//! the lines it touched and shifts the rows after them. Without soft wrap a
//! row is a line and nothing is measured while laying out: a row's width is
//! measured when `widest_row` first needs it.

use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
};

use nsh_core::geometry::Points;
use ropey::Rope;
use rustc_hash::FxHashMap;
use unicode_segmentation::{GraphemeIndices, UnicodeSegmentation};

use super::{
    buffer::{Buffer, LineSpan},
    fold::FoldRange,
    types::RowLayout,
};

/// One display row: a line, or the part of a soft-wrapped line one row
/// shows, or a fold's first line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row {
    /// The line the row shows (a fold's row: the fold's first line).
    pub(crate) line: usize,
    /// What it shows: byte offsets of the text, without the line break.
    pub(crate) range: Range<usize>,
    /// Whether the row starts its line (false for a wrapped line's
    /// continuation rows).
    pub(crate) first: bool,
    /// Where the row's text starts: a continuation row starts at its
    /// line's indentation, other rows at zero.
    pub(crate) indent: Points,
}

/// Texts of more rows than this measure their rows' widths as the rows
/// show ([`DisplayMap::measure_rows`]), never all at once: measuring every
/// row of a long text takes tens of milliseconds.
const EAGER_ROWS: usize = 20_000;

/// The text laid out in display rows.
pub(crate) struct DisplayMap {
    metrics: Metrics,
    wrap_width: Option<Points>,
    folds: Vec<FoldRange>,
    rows: Vec<Row>,
    /// The first row of every line; a hidden line has its fold's row.
    line_rows: Vec<usize>,
    /// Each row's width, indent included; NaN until measured.
    widths: RefCell<Vec<f32>>,
    /// The widest row, until the rows change.
    widest: Cell<Option<f32>>,
    /// The text the rows were laid out from, for measuring rows lazily (a
    /// rope's clone shares its chunks).
    rope: Rope,
    /// A line's text while it is wrapped, reused.
    scratch: String,
    /// A setting changed since the last rebuild: an edit lays everything
    /// out again.
    dirty: bool,
}

impl DisplayMap {
    /// `measure`: the width of a string on one line in the editor's font
    /// (the view passes `measure_text`). Widths are cached per char (sums
    /// of chars: monospace fonts, and close enough elsewhere; a grapheme of
    /// several chars, as an emoji with a modifier, is measured whole); a
    /// tab advances to the next stop, every `tab_size` spaces.
    pub(crate) fn new(measure: Rc<dyn Fn(&str) -> Points>, tab_size: u32) -> DisplayMap {
        DisplayMap {
            metrics: Metrics::new(measure, tab_size),
            wrap_width: None,
            folds: Vec::new(),
            rows: vec![Row {
                line: 0,
                range: 0..0,
                first: true,
                indent: Points::ZERO,
            }],
            line_rows: vec![0],
            widths: RefCell::new(vec![0.0]),
            widest: Cell::new(Some(0.0)),
            rope: Rope::new(),
            scratch: String::new(),
            dirty: false,
        }
    }

    /// A new font: the widths measured are dropped. Takes effect with the
    /// next [`Self::rebuild`].
    pub(crate) fn set_measure(&mut self, measure: Rc<dyn Fn(&str) -> Points>) {
        let tab_size = self.metrics.tab_size;
        self.metrics = Metrics::new(measure, tab_size);
        self.dirty = true;
    }

    /// Takes effect with the next [`Self::rebuild`].
    pub(crate) fn set_tab_size(&mut self, tab_size: u32) {
        if self.metrics.tab_size != tab_size {
            self.metrics.tab_size = tab_size;
            self.dirty = true;
        }
    }

    /// The width rows wrap at; None: no soft wrap. Takes effect with the
    /// next [`Self::rebuild`].
    pub(crate) fn set_wrap_width(&mut self, width: Option<Points>) {
        if self.wrap_width != width {
            self.wrap_width = width;
            self.dirty = true;
        }
    }

    /// The folded ranges (sorted, not overlapping). Takes effect with the
    /// next [`Self::rebuild`], which drops those that are empty, overlap
    /// an earlier one or end past the last line.
    pub(crate) fn set_folds(&mut self, folds: Vec<FoldRange>) {
        self.folds = folds;
        self.dirty = true;
    }

    /// The folded ranges.
    pub(crate) fn folds(&self) -> &[FoldRange] {
        &self.folds
    }

    /// Lays the whole text out again (a new text, font, tab size, width or
    /// folds).
    pub(crate) fn rebuild(&mut self, buffer: &Buffer) {
        let rope = buffer.rope();
        let line_count = buffer.line_count();
        self.folds = valid_folds(std::mem::take(&mut self.folds), line_count);
        let mut laid = Laid {
            rows: Vec::with_capacity(line_count),
            widths: Vec::with_capacity(line_count),
            line_rows: Vec::with_capacity(line_count),
        };
        layout_lines(
            &self.metrics,
            self.wrap_width,
            rope,
            0..line_count,
            0,
            &self.folds,
            0,
            &mut laid,
            &mut self.scratch,
        );
        self.rows = laid.rows;
        *self.widths.get_mut() = laid.widths;
        self.line_rows = laid.line_rows;
        self.widest.set(None);
        self.rope = rope.clone();
        self.dirty = false;
    }

    /// Lays out again only the lines of `span` (`LineSpan` from the
    /// buffer), shifting the rows after it; folds whose lines changed are
    /// dropped (their lines show again), those after the span shifted.
    pub(crate) fn edited(&mut self, buffer: &Buffer, span: LineSpan) {
        let rope = buffer.rope();
        let old_lines = self.line_rows.len();
        let LineSpan {
            first,
            old_count,
            new_count,
        } = span;
        // A span that does not fit the rows laid out (a change the map
        // missed, or a setting changed) lays everything out again.
        if self.dirty
            || first + old_count > old_lines
            || old_lines + new_count != buffer.line_count() + old_count
        {
            self.rebuild(buffer);
            return;
        }
        let delta = new_count as isize - old_count as isize;

        // The old lines `a..b` are laid out again: the span's, and the
        // whole of every fold it touches.
        let (mut a, mut b) = (first, first + old_count);
        let mut folds = Vec::with_capacity(self.folds.len());
        for fold in &self.folds {
            if fold.end < first {
                folds.push(*fold);
            } else if fold.start >= first + old_count {
                folds.push(FoldRange {
                    start: shift(fold.start, delta),
                    end: shift(fold.end, delta),
                });
            } else {
                a = a.min(fold.start);
                b = b.max(fold.end + 1);
            }
        }
        self.folds = folds;

        // Neither `a` nor `b` is hidden: folds kept end before the span or
        // start after it, and folds do not overlap.
        let r0 = self.line_rows[a];
        let r1 = if b < old_lines {
            self.line_rows[b]
        } else {
            self.rows.len()
        };
        let new_b = shift(b, delta);
        let byte_delta = if r1 < self.rows.len() {
            buffer.line_start(new_b) as isize - self.rows[r1].range.start as isize
        } else {
            0
        };

        let mut laid = Laid::default();
        layout_lines(
            &self.metrics,
            self.wrap_width,
            rope,
            a..new_b,
            buffer.line_start(a),
            &[],
            r0,
            &mut laid,
            &mut self.scratch,
        );
        let new_rows = laid.rows.len();
        let row_delta = new_rows as isize - (r1 - r0) as isize;
        let new_firsts = laid.line_rows.len();

        self.rows.splice(r0..r1, laid.rows);
        if delta != 0 || byte_delta != 0 {
            for row in &mut self.rows[r0 + new_rows..] {
                row.line = shift(row.line, delta);
                row.range = shift(row.range.start, byte_delta)..shift(row.range.end, byte_delta);
            }
        }
        self.widths.get_mut().splice(r0..r1, laid.widths);
        self.line_rows.splice(a..b, laid.line_rows);
        if row_delta != 0 {
            for row in &mut self.line_rows[a + new_firsts..] {
                *row = shift(*row, row_delta);
            }
        }
        self.widest.set(None);
        self.rope = rope.clone();
    }

    /// How many display rows there are (at least 1).
    pub(crate) fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Display row `row` (clamped to the last).
    pub(crate) fn row(&self, row: usize) -> &Row {
        &self.rows[row.min(self.rows.len() - 1)]
    }

    /// The first row of `line`, or of the fold that hides it (clamped to
    /// the last line).
    pub(crate) fn line_row(&self, line: usize) -> usize {
        self.line_rows[line.min(self.line_rows.len() - 1)]
    }

    /// Whether a fold hides `line`.
    pub(crate) fn is_hidden(&self, line: usize) -> bool {
        self.hiding_fold(line).is_some()
    }

    /// The fold hiding `line` (one of its lines after the first).
    pub(crate) fn hiding_fold(&self, line: usize) -> Option<FoldRange> {
        let at = self.folds.partition_point(|fold| fold.end < line);
        self.folds
            .get(at)
            .filter(|fold| fold.start < line && line <= fold.end)
            .copied()
    }

    /// The fold starting at `line`.
    #[cfg(test)]
    pub(crate) fn fold_at(&self, line: usize) -> Option<FoldRange> {
        let at = self.folds.partition_point(|fold| fold.start < line);
        self.folds
            .get(at)
            .filter(|fold| fold.start == line)
            .copied()
    }

    /// The row's text as shown: tabs as spaces, plus each tab's display
    /// range → buffer byte offset, so the view turns buffer ranges (tokens,
    /// decorations, matches) into ranges of this string.
    pub(crate) fn row_text(&self, buffer: &Buffer, row: usize) -> RowText {
        let range = self.row(row).range.clone();
        let source = slice_text(buffer.rope(), range.clone());
        let mut text = String::with_capacity(source.len());
        let mut tabs = Vec::new();
        let space = self.metrics.space();
        let mut x = 0.0;
        for (at, grapheme) in graphemes(&source) {
            let width = self.metrics.advance(grapheme, x);
            if grapheme == "\t" {
                let spaces = if space > 0.0 {
                    (width / space).round().max(1.0) as usize
                } else {
                    self.metrics.tab_size.max(1) as usize
                };
                let display = text.len();
                text.extend(std::iter::repeat_n(' ', spaces));
                tabs.push(TabSpan {
                    buffer: range.start + at,
                    display: display..text.len(),
                });
            } else {
                text.push_str(grapheme);
            }
            x += width;
        }
        RowText { text, range, tabs }
    }

    /// The x of `offset` within its row (from the text's left edge: a
    /// continuation row's indent included).
    #[cfg(test)]
    pub(crate) fn x_of(&self, buffer: &Buffer, offset: usize) -> Points {
        self.locate(buffer, offset).1
    }

    /// The display row `offset` is on and its x there (see
    /// [`RowLayout::locate`]).
    pub(crate) fn locate(&self, buffer: &Buffer, offset: usize) -> (usize, Points) {
        let rope = buffer.rope();
        let offset = buffer.clip(offset);
        let line = buffer.line_of(offset).min(self.line_rows.len() - 1);
        if let Some(fold) = self.hiding_fold(line) {
            let row = self.line_rows[fold.start];
            let end = self.rows[row].range.end;
            return (row, self.x_in_row(rope, row, end));
        }
        let first = self.line_rows[line];
        let count = self.rows[first..]
            .partition_point(|row| row.line == line)
            .max(1);
        let at = self.rows[first..first + count].partition_point(|row| row.range.start <= offset);
        let row = first + at.saturating_sub(1);
        (row, self.x_in_row(rope, row, offset))
    }

    /// The offset in display row `row` nearest to `x` (see
    /// [`RowLayout::offset_at`]).
    pub(crate) fn offset_at(&self, buffer: &Buffer, row: usize, x: Points) -> usize {
        let index = row.min(self.rows.len() - 1);
        let row = &self.rows[index];
        let text = slice_text(buffer.rope(), row.range.clone());
        let target = x.0 - row.indent.0;
        let mut cx = 0.0;
        let mut last = None;
        for (at, grapheme) in graphemes(&text) {
            let width = self.metrics.advance(grapheme, cx);
            if target < cx + width / 2.0 {
                return row.range.start + at;
            }
            cx += width;
            last = Some(at);
        }
        // The end of a soft-wrapped row is where the next row starts: the
        // caret stays on this row before its last grapheme.
        let wraps = self
            .rows
            .get(index + 1)
            .is_some_and(|next| next.line == row.line && !next.first);
        match last {
            Some(at) if wraps => row.range.start + at,
            _ => row.range.end,
        }
    }

    /// The widest row (for the scroll width without soft wrap); rows not
    /// measured yet are measured now.
    pub(crate) fn widest_row(&self) -> Points {
        if let Some(widest) = self.widest.get() {
            return Points(widest);
        }
        let mut widths = self.widths.borrow_mut();
        let mut text = String::new();
        let mut widest = 0.0f32;
        let eager = self.rows.len() <= EAGER_ROWS;
        for (row, width) in self.rows.iter().zip(widths.iter_mut()) {
            if width.is_nan() {
                if !eager {
                    // Measured once shown (`measure_rows`).
                    continue;
                }
                text.clear();
                for chunk in self.rope.byte_slice(row.range.clone()).chunks() {
                    text.push_str(chunk);
                }
                *width = row.indent.0 + self.metrics.run_width(&text);
            }
            widest = widest.max(*width);
        }
        self.widest.set(Some(widest));
        Points(widest)
    }

    /// Measures rows `range` (those shown) of a text whose widths are
    /// measured as its rows show ([`EAGER_ROWS`]): the widest row grows
    /// with what was seen, as in editors that never read a long text whole.
    pub(crate) fn measure_rows(&self, range: Range<usize>) {
        if self.rows.len() <= EAGER_ROWS {
            return;
        }
        let mut widths = self.widths.borrow_mut();
        let mut text = String::new();
        let end = range.end.min(self.rows.len());
        for index in range.start.min(end)..end {
            let width = &mut widths[index];
            if !width.is_nan() {
                continue;
            }
            let row = &self.rows[index];
            text.clear();
            for chunk in self.rope.byte_slice(row.range.clone()).chunks() {
                text.push_str(chunk);
            }
            *width = row.indent.0 + self.metrics.run_width(&text);
            if let Some(widest) = self.widest.get()
                && *width > widest
            {
                self.widest.set(Some(*width));
            }
        }
    }

    /// The width of a space in the editor's font (selections past a line's
    /// end, indent guides).
    pub(crate) fn space_width(&self) -> Points {
        Points(self.metrics.space())
    }

    /// A `RowLayout` over this map and `buffer`.
    pub(crate) fn layout<'a>(&'a self, buffer: &'a Buffer) -> impl RowLayout + 'a {
        MapLayout { map: self, buffer }
    }

    /// The x of `offset` (clamped to the row) in display row `row`, its
    /// indent included: a wrapped row's end is on it, where [`Self::locate`]
    /// puts the next row's start.
    pub(crate) fn x_in(&self, buffer: &Buffer, row: usize, offset: usize) -> Points {
        self.x_in_row(buffer.rope(), row, offset)
    }

    /// The x of `offset` (clamped to the row) in row `row`.
    fn x_in_row(&self, rope: &Rope, row: usize, offset: usize) -> Points {
        let row = &self.rows[row];
        let end = offset.clamp(row.range.start, row.range.end);
        let end = end.min(rope.len_bytes());
        let start = row.range.start.min(end);
        let text = slice_text(rope, start..end);
        Points(row.indent.0 + self.metrics.run_width(&text))
    }

    /// The whitespace display row `row` shows (`showWhitespaces`): each run
    /// of spaces and each tab, where it starts (the row's indent included)
    /// and how wide it is.
    pub(crate) fn whitespace(&self, buffer: &Buffer, row: usize) -> Vec<Whitespace> {
        let info = self.row(row);
        let text = slice_text(buffer.rope(), info.range.clone());
        let mut out: Vec<Whitespace> = Vec::new();
        let mut x = 0.0;
        // The previous grapheme was a space: a space extends its run.
        let mut after_space = false;
        for (_, grapheme) in graphemes(&text) {
            let width = self.metrics.advance(grapheme, x);
            match grapheme {
                " " => match out.last_mut() {
                    Some(run) if after_space => {
                        run.width = Points(run.width.0 + width);
                        run.count += 1;
                    }
                    _ => out.push(Whitespace {
                        x: Points(info.indent.0 + x),
                        width: Points(width),
                        count: 1,
                        tab: false,
                    }),
                },
                "\t" => out.push(Whitespace {
                    x: Points(info.indent.0 + x),
                    width: Points(width),
                    count: 1,
                    tab: true,
                }),
                _ => {}
            }
            after_space = grapheme == " ";
            x += width;
        }
        out
    }
}

/// A run of spaces or a tab of a row ([`DisplayMap::whitespace`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Whitespace {
    /// Where it starts, from the text's left edge.
    pub(crate) x: Points,
    /// How wide it is.
    pub(crate) width: Points,
    /// How many spaces (1 for a tab).
    pub(crate) count: usize,
    /// It is a tab.
    pub(crate) tab: bool,
}

/// A row's text as shown, and how its offsets map to the buffer's.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RowText {
    /// The text: the row's, with every tab as spaces.
    pub(crate) text: String,
    /// The buffer range the row shows.
    pub(crate) range: Range<usize>,
    /// The tabs, in order: the only chars whose display length differs.
    tabs: Vec<TabSpan>,
}

/// A tab of a row and the spaces it shows as.
#[derive(Debug, Clone, PartialEq)]
struct TabSpan {
    /// The tab's byte offset in the buffer.
    buffer: usize,
    /// Its spaces in the row's text.
    display: Range<usize>,
}

impl RowText {
    /// `buffer_range` as a range of [`Self::text`], clamped to the row.
    pub(crate) fn display_range(&self, buffer_range: Range<usize>) -> Range<usize> {
        let start = self.display_offset(buffer_range.start);
        let end = self.display_offset(buffer_range.end);
        start..end.max(start)
    }

    /// Buffer offset `offset` as an offset of [`Self::text`], clamped to
    /// the row.
    pub(crate) fn display_offset(&self, offset: usize) -> usize {
        let offset = offset.clamp(self.range.start, self.range.end);
        let before = self.tabs.partition_point(|tab| tab.buffer < offset);
        match before.checked_sub(1).map(|i| &self.tabs[i]) {
            None => offset - self.range.start,
            Some(tab) => tab.display.end + (offset - tab.buffer - 1),
        }
    }

    /// Offset `display` of [`Self::text`] as a buffer offset (inside a
    /// tab's spaces: the tab's start).
    #[cfg(test)]
    pub(crate) fn buffer_offset(&self, display: usize) -> usize {
        let display = display.min(self.text.len());
        let before = self.tabs.partition_point(|tab| tab.display.start < display);
        match before.checked_sub(1).map(|i| &self.tabs[i]) {
            None => self.range.start + display,
            Some(tab) if display < tab.display.end => tab.buffer,
            Some(tab) => tab.buffer + 1 + (display - tab.display.end),
        }
        .min(self.range.end)
    }
}

/// [`RowLayout`] over a display map and the buffer it laid out.
struct MapLayout<'a> {
    map: &'a DisplayMap,
    buffer: &'a Buffer,
}

impl RowLayout for MapLayout<'_> {
    fn row_count(&self) -> usize {
        self.map.row_count()
    }

    fn locate(&self, offset: usize) -> (usize, Points) {
        self.map.locate(self.buffer, offset)
    }

    fn offset_at(&self, row: usize, x: Points) -> usize {
        self.map.offset_at(self.buffer, row, x)
    }

    fn row_range(&self, row: usize) -> Range<usize> {
        self.map.row(row).range.clone()
    }
}

/// What laying out lines makes.
#[derive(Default)]
struct Laid {
    rows: Vec<Row>,
    widths: Vec<f32>,
    line_rows: Vec<usize>,
}

/// Lays out `lines` (starting at byte `start`) of `rope` into `out`, the
/// rows numbered from `row_base`; `folds` are those starting among `lines`.
#[allow(clippy::too_many_arguments)]
fn layout_lines(
    metrics: &Metrics,
    wrap: Option<Points>,
    rope: &Rope,
    lines: Range<usize>,
    start: usize,
    folds: &[FoldRange],
    row_base: usize,
    out: &mut Laid,
    scratch: &mut String,
) {
    if lines.is_empty() {
        return;
    }
    let mut iter = LineRanges::new(rope, start);
    let mut folds = folds.iter().copied().peekable();
    let mut line = lines.start;
    while line < lines.end {
        let Some(range) = iter.next() else { break };
        let row = row_base + out.rows.len();
        out.line_rows.push(row);
        while folds.peek().is_some_and(|fold| fold.start < line) {
            folds.next();
        }
        if let Some(fold) = folds.next_if(|fold| fold.start == line) {
            // A fold shows its first line as one row; its other lines
            // have none.
            out.rows.push(Row {
                line,
                range,
                first: true,
                indent: Points::ZERO,
            });
            out.widths.push(f32::NAN);
            let last = fold.end.min(lines.end - 1);
            for _ in line + 1..=last {
                if iter.next().is_none() {
                    break;
                }
                out.line_rows.push(row);
            }
            line = last + 1;
            continue;
        }
        match wrap {
            None => {
                out.rows.push(Row {
                    line,
                    range,
                    first: true,
                    indent: Points::ZERO,
                });
                out.widths.push(f32::NAN);
            }
            Some(width) => {
                scratch.clear();
                for chunk in rope.byte_slice(range.clone()).chunks() {
                    scratch.push_str(chunk);
                }
                wrap_line(metrics, width, line, range.start, scratch, out);
            }
        }
        line += 1;
    }
}

/// The lines of a rope from a line's start on, as byte ranges without
/// their `\n`: the buffer's lines, which end at `\n` only (ropey's line
/// index also counts U+2028 and others).
struct LineRanges<'a> {
    chunks: ropey::iter::Chunks<'a>,
    chunk: &'a str,
    chunk_start: usize,
    at: usize,
    finished: bool,
}

impl<'a> LineRanges<'a> {
    fn new(rope: &'a Rope, start: usize) -> LineRanges<'a> {
        let start = start.min(rope.len_bytes());
        let (mut chunks, chunk_start, _, _) = rope.chunks_at_byte(start);
        let (chunk, chunk_start) = match chunks.next() {
            Some(chunk) => (chunk, chunk_start),
            None => ("", start),
        };
        LineRanges {
            chunks,
            chunk,
            chunk_start,
            at: start,
            finished: false,
        }
    }
}

impl Iterator for LineRanges<'_> {
    type Item = Range<usize>;

    fn next(&mut self) -> Option<Range<usize>> {
        if self.finished {
            return None;
        }
        let start = self.at;
        loop {
            let local = self.at - self.chunk_start;
            if let Some(i) = self.chunk[local..].find('\n') {
                let end = self.at + i;
                self.at = end + 1;
                return Some(start..end);
            }
            self.at = self.chunk_start + self.chunk.len();
            match self.chunks.next() {
                Some(chunk) => {
                    self.chunk_start = self.at;
                    self.chunk = chunk;
                }
                None => {
                    self.finished = true;
                    return Some(start..self.at);
                }
            }
        }
    }
}

/// Soft-wraps one line (`text`, at byte `start` of the text) at `width`:
/// after whitespace when the row would overflow, else between graphemes;
/// whitespace never wraps (it hangs past the edge). Continuation rows start
/// at the line's indentation unless that is over half the width.
fn wrap_line(
    metrics: &Metrics,
    width: Points,
    line: usize,
    start: usize,
    text: &str,
    out: &mut Laid,
) {
    let width = width.0.max(1.0);
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let lead_width = metrics.run_width(&text[..lead]);
    let indent = if lead_width > width / 2.0 {
        0.0
    } else {
        lead_width
    };
    let mut push = |range: Range<usize>, row_indent: f32, row_width: f32| {
        out.rows.push(Row {
            line,
            first: range.start == 0,
            range: start + range.start..start + range.end,
            indent: Points(row_indent),
        });
        out.widths.push(row_indent + row_width);
    };

    let mut row_start = 0;
    let mut row_indent = 0.0;
    let mut available = width;
    let mut x = 0.0;
    // Where the row may break: after the last whitespace, and the x there.
    let mut break_at: Option<(usize, f32)> = None;
    for (at, grapheme) in graphemes(text) {
        let blank = grapheme.chars().all(char::is_whitespace);
        let advance = metrics.advance(grapheme, x);
        while !blank && at > row_start && x + advance > available {
            let (end, end_x) = match break_at {
                Some((offset, offset_x)) if offset > row_start => (offset, offset_x),
                _ => (at, x),
            };
            push(row_start..end, row_indent, end_x);
            x -= end_x;
            row_start = end;
            row_indent = indent;
            available = width - indent;
            break_at = None;
        }
        x += advance;
        // The indentation is no place to break: a row of only it is no use.
        if blank && at + grapheme.len() > lead {
            break_at = Some((at + grapheme.len(), x));
        }
    }
    push(row_start..text.len(), row_indent, x);
}

/// Widths in the editor's font, measured once per char (or grapheme of
/// several chars) and cached.
struct Metrics {
    measure: Rc<dyn Fn(&str) -> Points>,
    tab_size: u32,
    /// ASCII widths by byte, NaN until measured: no hashing on the common
    /// path.
    ascii: [Cell<f32>; 128],
    chars: RefCell<FxHashMap<char, f32>>,
    clusters: RefCell<FxHashMap<Box<str>, f32>>,
}

impl Metrics {
    fn new(measure: Rc<dyn Fn(&str) -> Points>, tab_size: u32) -> Metrics {
        Metrics {
            measure,
            tab_size,
            ascii: std::array::from_fn(|_| Cell::new(f32::NAN)),
            chars: RefCell::default(),
            clusters: RefCell::default(),
        }
    }

    /// The width of one grapheme (not a tab).
    fn width(&self, grapheme: &str) -> f32 {
        let bytes = grapheme.as_bytes();
        if let [byte] = bytes
            && *byte < 128
        {
            let cell = &self.ascii[*byte as usize];
            let width = cell.get();
            if !width.is_nan() {
                return width;
            }
            let width = (self.measure)(grapheme).0;
            cell.set(width);
            return width;
        }
        let mut chars = grapheme.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if let Some(&width) = self.chars.borrow().get(&c) {
                return width;
            }
            let width = (self.measure)(grapheme).0;
            self.chars.borrow_mut().insert(c, width);
            return width;
        }
        if let Some(&width) = self.clusters.borrow().get(grapheme) {
            return width;
        }
        let width = (self.measure)(grapheme).0;
        self.clusters.borrow_mut().insert(grapheme.into(), width);
        width
    }

    fn space(&self) -> f32 {
        self.width(" ")
    }

    /// How far `grapheme` at `x` advances: a tab to the next stop.
    fn advance(&self, grapheme: &str, x: f32) -> f32 {
        if grapheme != "\t" {
            return self.width(grapheme);
        }
        let stop = self.space() * self.tab_size.max(1) as f32;
        if stop <= 0.0 {
            return 0.0;
        }
        // The epsilon keeps an x a rounding error short of a stop at it.
        let next = ((x / stop + 1e-4).floor() + 1.0) * stop;
        next - x
    }

    /// The width of `text` from x 0.
    fn run_width(&self, text: &str) -> f32 {
        let mut x = 0.0;
        for (_, grapheme) in graphemes(text) {
            x += self.advance(grapheme, x);
        }
        x
    }
}

/// The graphemes of `text` with their byte offsets; ASCII text (where each
/// byte is one) skips segmentation.
fn graphemes(text: &str) -> Graphemes<'_> {
    if text.is_ascii() {
        Graphemes::Ascii(text, 0)
    } else {
        Graphemes::Unicode(text.grapheme_indices(true))
    }
}

enum Graphemes<'a> {
    Ascii(&'a str, usize),
    Unicode(GraphemeIndices<'a>),
}

impl<'a> Iterator for Graphemes<'a> {
    type Item = (usize, &'a str);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Graphemes::Ascii(text, at) => {
                let start = *at;
                if start >= text.len() {
                    return None;
                }
                *at += 1;
                Some((start, &text[start..start + 1]))
            }
            Graphemes::Unicode(inner) => inner.next(),
        }
    }
}

/// The text of `range` of `rope`.
fn slice_text(rope: &Rope, range: Range<usize>) -> String {
    let end = range.end.min(rope.len_bytes());
    let start = range.start.min(end);
    let mut text = String::with_capacity(end - start);
    for chunk in rope.byte_slice(start..end).chunks() {
        text.push_str(chunk);
    }
    text
}

/// `folds` sorted, without empty ones, ones past the last line and ones
/// overlapping an earlier one.
fn valid_folds(mut folds: Vec<FoldRange>, line_count: usize) -> Vec<FoldRange> {
    folds.sort_by_key(|fold| (fold.start, fold.end));
    let mut last_end = None;
    folds.retain(|fold| {
        let keep = fold.start < fold.end
            && fold.end < line_count
            && last_end.is_none_or(|end| fold.start > end);
        if keep {
            last_end = Some(fold.end);
        }
        keep
    });
    folds
}

fn shift(value: usize, delta: isize) -> usize {
    value.saturating_add_signed(delta)
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::{
        super::{buffer::EditKind, types::Selections},
        *,
    };

    /// Every char 10 points, CJK 20.
    fn measure() -> Rc<dyn Fn(&str) -> Points> {
        Rc::new(|text: &str| {
            px(text
                .chars()
                .map(|c| {
                    if ('\u{4E00}'..='\u{9FFF}').contains(&c)
                        || ('\u{FF00}'..='\u{FFEF}').contains(&c)
                    {
                        20.0
                    } else {
                        10.0
                    }
                })
                .sum())
        })
    }

    fn map(buffer: &Buffer, wrap: Option<f32>, folds: Vec<FoldRange>) -> DisplayMap {
        let mut map = DisplayMap::new(measure(), 4);
        map.set_wrap_width(wrap.map(px));
        map.set_folds(folds);
        map.rebuild(buffer);
        map
    }

    fn ranges(map: &DisplayMap) -> Vec<Range<usize>> {
        map.rows.iter().map(|row| row.range.clone()).collect()
    }

    fn fold(start: usize, end: usize) -> FoldRange {
        FoldRange { start, end }
    }

    /// The map after an incremental edit equals one laid out from scratch.
    fn assert_same_as_rebuilt(map: &DisplayMap, buffer: &Buffer) {
        let fresh = self::map(buffer, map.wrap_width.map(|w| w.0), map.folds.clone());
        assert_eq!(map.rows, fresh.rows);
        assert_eq!(map.line_rows, fresh.line_rows);
        assert_eq!(map.folds, fresh.folds);
        assert_eq!(map.widest_row(), fresh.widest_row());
    }

    fn edit(buffer: &mut Buffer, map: &mut DisplayMap, range: Range<usize>, text: &str) {
        let selections = Selections::default();
        buffer.edit(
            vec![(range, text.to_string())],
            &selections,
            &selections,
            EditKind::Other,
        );
        let span = buffer.last_line_span().expect("a span");
        map.edited(buffer, span);
    }

    #[test]
    fn empty_text_is_one_empty_row() {
        let buffer = Buffer::new("");
        let map = map(&buffer, None, vec![]);
        assert_eq!(map.row_count(), 1);
        assert_eq!(map.row(0).range, 0..0);
        assert_eq!(map.row(5).range, 0..0);
        assert_eq!(map.widest_row(), Points::ZERO);
        assert_eq!(map.locate(&buffer, 0), (0, Points::ZERO));
        assert_eq!(map.offset_at(&buffer, 0, px(100.0)), 0);
    }

    #[test]
    fn rows_are_lines_without_wrap() {
        let buffer = Buffer::new("a\nbc\n");
        let map = map(&buffer, None, vec![]);
        assert_eq!(ranges(&map), vec![0..1, 2..4, 5..5]);
        assert!(map.rows.iter().all(|row| row.first));
        assert_eq!(map.line_row(1), 1);
        assert_eq!(map.line_row(9), 2);
        assert_eq!(map.widest_row(), px(20.0));
    }

    #[test]
    fn crlf_input_lays_out_as_lines() {
        let buffer = Buffer::new("ab\r\ncd\re");
        let map = map(&buffer, None, vec![]);
        assert_eq!(ranges(&map), vec![0..2, 3..5, 6..7]);
    }

    #[test]
    fn lines_end_at_line_feeds_only() {
        // Ropey counts U+2028 as a line break; the buffer does not.
        let mut buffer = Buffer::new("a\u{2028}b\nc");
        let mut map = map(&buffer, None, vec![]);
        assert_eq!(ranges(&map), vec![0..5, 6..7]);
        assert_eq!(map.locate(&buffer, 6), (1, Points::ZERO));
        edit(&mut buffer, &mut map, 6..6, "x\u{2029}\n");
        assert_same_as_rebuilt(&map, &buffer);
        assert_eq!(map.row_count(), 3);
    }

    #[test]
    fn wraps_after_whitespace() {
        let buffer = Buffer::new("hello world foo");
        let map = map(&buffer, Some(60.0), vec![]);
        assert_eq!(ranges(&map), vec![0..6, 6..12, 12..15]);
        assert_eq!(
            map.rows.iter().map(|row| row.first).collect::<Vec<_>>(),
            vec![true, false, false]
        );
        assert_eq!(map.line_row(0), 0);
        assert_eq!(map.widest_row(), px(60.0));
    }

    #[test]
    fn a_long_word_wraps_between_chars() {
        let buffer = Buffer::new("abcdefghij");
        let map = map(&buffer, Some(30.0), vec![]);
        assert_eq!(ranges(&map), vec![0..3, 3..6, 6..9, 9..10]);
    }

    #[test]
    fn continuation_rows_start_at_the_indentation() {
        let buffer = Buffer::new("    aaaa bbbb");
        let map = map(&buffer, Some(80.0), vec![]);
        assert_eq!(ranges(&map), vec![0..9, 9..13]);
        assert_eq!(map.row(0).indent, Points::ZERO);
        assert_eq!(map.row(1).indent, px(40.0));
        assert_eq!(map.x_of(&buffer, 9), px(40.0));
        assert_eq!(map.x_of(&buffer, 11), px(60.0));
        assert_eq!(map.offset_at(&buffer, 1, px(0.0)), 9);
        assert_eq!(map.offset_at(&buffer, 1, px(56.0)), 11);
    }

    #[test]
    fn an_indentation_over_half_the_width_is_not_kept() {
        let buffer = Buffer::new("      abcdefgh");
        let map = map(&buffer, Some(100.0), vec![]);
        assert_eq!(ranges(&map), vec![0..10, 10..14]);
        assert_eq!(map.row(1).indent, Points::ZERO);
    }

    #[test]
    fn cjk_is_measured_wide() {
        let buffer = Buffer::new("中文字");
        let map = map(&buffer, Some(50.0), vec![]);
        assert_eq!(ranges(&map), vec![0..6, 6..9]);
        assert_eq!(map.x_of(&buffer, 3), px(20.0));
        assert_eq!(map.offset_at(&buffer, 0, px(25.0)), 3);
    }

    #[test]
    fn wrapping_never_splits_a_grapheme() {
        // The thumbs up and its skin tone modifier are one grapheme.
        let buffer = Buffer::new("a👍🏽b");
        let map = map(&buffer, Some(20.0), vec![]);
        assert_eq!(ranges(&map), vec![0..1, 1..9, 9..10]);
        // A grapheme wider than the row still gets one.
        let map = self::map(&buffer, Some(5.0), vec![]);
        assert_eq!(ranges(&map), vec![0..1, 1..9, 9..10]);
        // No wrap: the caret steps over the grapheme as a whole.
        let map = self::map(&buffer, None, vec![]);
        assert_eq!(map.x_of(&buffer, 9), px(30.0));
        assert_eq!(map.offset_at(&buffer, 0, px(18.0)), 1);
        assert_eq!(map.offset_at(&buffer, 0, px(22.0)), 9);
    }

    #[test]
    fn tabs_advance_to_the_next_stop() {
        let buffer = Buffer::new("a\tb\n\tc");
        let map = map(&buffer, None, vec![]);
        assert_eq!(map.x_of(&buffer, 1), px(10.0));
        assert_eq!(map.x_of(&buffer, 2), px(40.0));
        assert_eq!(map.x_of(&buffer, 3), px(50.0));
        assert_eq!(map.x_of(&buffer, 5), px(40.0));
        let text = map.row_text(&buffer, 0);
        assert_eq!(text.text, "a   b");
        assert_eq!(text.display_range(0..1), 0..1);
        assert_eq!(text.display_range(1..2), 1..4);
        assert_eq!(text.display_range(2..3), 4..5);
        assert_eq!(text.display_range(0..99), 0..5);
        assert_eq!(text.buffer_offset(2), 1);
        assert_eq!(text.buffer_offset(4), 2);
        assert_eq!(text.buffer_offset(5), 3);
        let text = map.row_text(&buffer, 1);
        assert_eq!(text.text, "    c");
        assert_eq!(text.display_range(5..6), 4..5);
        // Past the middle of the tab's advance is after it.
        assert_eq!(map.offset_at(&buffer, 0, px(24.0)), 1);
        assert_eq!(map.offset_at(&buffer, 0, px(26.0)), 2);
        assert_eq!(map.widest_row(), px(50.0));
    }

    #[test]
    fn row_text_maps_multibyte_text() {
        let buffer = Buffer::new("é\t中");
        let map = map(&buffer, None, vec![]);
        let text = map.row_text(&buffer, 0);
        assert_eq!(text.text, "é   中");
        assert_eq!(text.display_range(0..2), 0..2);
        assert_eq!(text.display_range(3..6), 5..8);
    }

    #[test]
    fn a_fold_shows_its_first_line() {
        let buffer = Buffer::new("a\nbb\nc\nd\ne");
        let map = map(&buffer, None, vec![fold(1, 3)]);
        assert_eq!(ranges(&map), vec![0..1, 2..4, 9..10]);
        assert_eq!(map.row_count(), 3);
        assert_eq!(map.line_row(2), 1);
        assert_eq!(map.line_row(3), 1);
        assert_eq!(map.line_row(4), 2);
        assert!(!map.is_hidden(1));
        assert!(map.is_hidden(2));
        assert!(map.is_hidden(3));
        assert!(!map.is_hidden(4));
        assert_eq!(map.fold_at(1), Some(fold(1, 3)));
        // An offset in a hidden line is at the end of the fold's first line.
        assert_eq!(map.locate(&buffer, 5), (1, px(20.0)));
        assert_eq!(map.locate(&buffer, 9), (2, Points::ZERO));
        let layout = map.layout(&buffer);
        assert_eq!(layout.row_count(), 3);
        assert_eq!(layout.row_range(2), 9..10);
    }

    #[test]
    fn invalid_folds_are_dropped() {
        let buffer = Buffer::new("a\nb\nc\nd");
        let map = map(
            &buffer,
            None,
            vec![fold(2, 9), fold(0, 1), fold(1, 2), fold(3, 3)],
        );
        assert_eq!(map.folds(), &[fold(0, 1)]);
    }

    #[test]
    fn locate_and_offset_at_soft_wrapped_rows() {
        let buffer = Buffer::new("hello world foo");
        let map = map(&buffer, Some(60.0), vec![]);
        // Where a line wraps is the start of the next row.
        assert_eq!(map.locate(&buffer, 6), (1, Points::ZERO));
        assert_eq!(map.locate(&buffer, 5), (0, px(50.0)));
        assert_eq!(map.locate(&buffer, 15), (2, px(30.0)));
        assert_eq!(map.offset_at(&buffer, 0, px(24.0)), 2);
        assert_eq!(map.offset_at(&buffer, 0, px(26.0)), 3);
        // Past a wrapped row's end: before its last grapheme.
        assert_eq!(map.offset_at(&buffer, 0, px(1000.0)), 5);
        assert_eq!(map.offset_at(&buffer, 2, px(1000.0)), 15);
        assert_eq!(map.offset_at(&buffer, 1, px(-5.0)), 6);
        let layout = map.layout(&buffer);
        assert_eq!(layout.locate(12), (2, Points::ZERO));
        assert_eq!(layout.offset_at(1, px(15.0)), 8);
    }

    #[test]
    fn edits_lay_out_only_their_lines() {
        let text = "fn main() {\n    let x = 1;\n}\n\nlast line here";
        for wrap in [None, Some(70.0)] {
            let mut buffer = Buffer::new(text);
            let mut map = map(&buffer, wrap, vec![]);
            // Typing in a line.
            edit(&mut buffer, &mut map, 20..20, "mut ");
            assert_same_as_rebuilt(&map, &buffer);
            // Breaking a line.
            edit(&mut buffer, &mut map, 5..5, "\n");
            assert_same_as_rebuilt(&map, &buffer);
            // Joining lines across several.
            let start = buffer.line_end(0);
            let end = buffer.line_start(3);
            edit(&mut buffer, &mut map, start..end, "");
            assert_same_as_rebuilt(&map, &buffer);
            // At the end, with multibyte text.
            let len = buffer.len();
            edit(&mut buffer, &mut map, len..len, "\n中文 👍🏽 é");
            assert_same_as_rebuilt(&map, &buffer);
            // Everything.
            let len = buffer.len();
            edit(&mut buffer, &mut map, 0..len, "");
            assert_same_as_rebuilt(&map, &buffer);
            assert_eq!(map.row_count(), 1);
        }
    }

    #[test]
    fn edits_shift_and_drop_folds() {
        let mut buffer = Buffer::new("l0\nl1\nl2\nl3\nl4\nl5\nl6");
        let mut map = map(&buffer, None, vec![fold(1, 2), fold(4, 5)]);
        // Lines inserted above shift both folds.
        edit(&mut buffer, &mut map, 0..0, "x\ny\n");
        assert_eq!(map.folds(), &[fold(3, 4), fold(6, 7)]);
        assert_same_as_rebuilt(&map, &buffer);
        // An edit in a hidden line drops its fold: its lines show again.
        let at = buffer.line_start(4);
        edit(&mut buffer, &mut map, at..at, "z");
        assert_eq!(map.folds(), &[fold(6, 7)]);
        assert_same_as_rebuilt(&map, &buffer);
        assert!(!map.is_hidden(4));
        // An edit after a fold keeps it.
        let at = buffer.len();
        edit(&mut buffer, &mut map, at..at, "\nmore");
        assert_eq!(map.folds(), &[fold(6, 7)]);
        assert_same_as_rebuilt(&map, &buffer);
        // Deleting a fold's first line drops it.
        let start = buffer.line_start(6);
        let end = buffer.line_start(7);
        edit(&mut buffer, &mut map, start..end, "");
        assert_eq!(map.folds(), &[]);
        assert_same_as_rebuilt(&map, &buffer);
    }

    #[test]
    fn a_stale_span_rebuilds() {
        let mut buffer = Buffer::new("a\nb");
        let mut map = map(&buffer, None, vec![]);
        buffer.reset("one\ntwo\nthree\nfour");
        map.edited(
            &buffer,
            LineSpan {
                first: 0,
                old_count: 1,
                new_count: 1,
            },
        );
        assert_same_as_rebuilt(&map, &buffer);
        assert_eq!(map.row_count(), 4);
    }

    #[test]
    fn a_new_measure_clears_the_widths() {
        let buffer = Buffer::new("abc");
        let mut map = map(&buffer, None, vec![]);
        assert_eq!(map.widest_row(), px(30.0));
        map.set_measure(Rc::new(|text: &str| px(text.chars().count() as f32 * 7.0)));
        map.rebuild(&buffer);
        assert_eq!(map.widest_row(), px(21.0));
        assert_eq!(map.x_of(&buffer, 2), px(14.0));
    }

    #[test]
    fn widths_are_measured_once_per_char() {
        let calls = Rc::new(Cell::new(0));
        let counted = calls.clone();
        let mut map = DisplayMap::new(
            Rc::new(move |text: &str| {
                counted.set(counted.get() + 1);
                px(text.chars().count() as f32 * 10.0)
            }),
            4,
        );
        let buffer = Buffer::new("aaaa\nabab\nééé");
        map.set_wrap_width(Some(px(1000.0)));
        map.rebuild(&buffer);
        // a, b, é.
        assert_eq!(calls.get(), 3);
        map.widest_row();
        map.x_of(&buffer, 3);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn a_big_file_lays_out_as_lines() {
        let text: Vec<String> = (0..100_000).map(|i| format!("line {i}\tvalue")).collect();
        let mut buffer = Buffer::new(&text.join("\n"));
        let mut map = map(&buffer, None, vec![]);
        assert_eq!(map.row_count(), 100_000);
        assert_eq!(map.line_row(99_999), 99_999);
        assert_eq!(map.row(50_000).line, 50_000);
        let at = buffer.line_start(99_999) + 4;
        assert_eq!(map.locate(&buffer, at), (99_999, px(40.0)));
        // An edit near the start shifts every row after it.
        edit(&mut buffer, &mut map, 0..0, "first\n");
        assert_eq!(map.row_count(), 100_001);
        assert_eq!(map.locate(&buffer, at + 6), (100_000, px(40.0)));
        assert_eq!(
            map.row(100_000).range,
            buffer.line_start(100_000)..buffer.len()
        );
    }

    #[test]
    fn whitespace_is_runs_of_spaces_and_tabs() {
        let buffer = Buffer::new("a  b\t c\n  x\nnone");
        let map = map(&buffer, None, vec![]);
        let ws = |x: f32, width: f32, count: usize, tab: bool| Whitespace {
            x: px(x),
            width: px(width),
            count,
            tab,
        };
        // Two spaces in one run; the tab advances to its stop (40 → 80),
        // and the space after it starts a run of its own.
        assert_eq!(
            map.whitespace(&buffer, 0),
            vec![
                ws(10.0, 20.0, 2, false),
                ws(40.0, 40.0, 1, true),
                ws(80.0, 10.0, 1, false),
            ]
        );
        assert_eq!(map.whitespace(&buffer, 1), vec![ws(0.0, 20.0, 2, false)]);
        assert!(map.whitespace(&buffer, 2).is_empty());
    }
}
