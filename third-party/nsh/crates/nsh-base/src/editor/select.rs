//! Selecting beyond single commands: the history of selections
//! (`undoSelection`, `redoSelection`), growing and shrinking a selection by
//! syntax-free units (`expandSelection`, `shrinkSelection`), block
//! selections dragged with Alt+Shift, and the scope of a search in the
//! selection (`EditorSearch::in_selection`).
//!
//! Expanding has no syntax tree to climb: it grows each selection to the
//! smallest of the units around it that is larger than it, from the word,
//! a quoted string's contents and the string, a bracket pair's contents and
//! the pair, out to the line's text, the whole lines and the whole text.

use std::ops::Range;

use nsh_core::geometry::{Point as Pt, Points, px};

use super::{
    EditorEvent, EditorSearch,
    buffer::Buffer,
    commands::Outcome,
    controller::Ed,
    diagnostics::Mark,
    language::LanguageConfig,
    movement,
    state::State,
    types::{RowLayout, Selection, Selections},
};

/// How many earlier selections `undoSelection` can go back to.
const HISTORY_LIMIT: usize = 100;

/// The selections the editor had, to go back and forth between. Moves
/// record what they leave; an edit forgets everything, as offsets before it
/// no longer mean the same text.
#[derive(Debug, Default)]
pub(crate) struct SelectionHistory {
    undo: Vec<Selections>,
    redo: Vec<Selections>,
    current: Option<Selections>,
}

impl SelectionHistory {
    /// A history starting at `selections`.
    pub(crate) fn new(selections: &Selections) -> SelectionHistory {
        SelectionHistory {
            current: Some(selections.clone()),
            ..SelectionHistory::default()
        }
    }

    /// The selections are now `selections`: what they were becomes a step
    /// back, and the steps forward are gone.
    pub(crate) fn record(&mut self, selections: &Selections) {
        if self.current.as_ref() == Some(selections) {
            return;
        }
        if let Some(previous) = self.current.replace(selections.clone()) {
            self.undo.push(previous);
            if self.undo.len() > HISTORY_LIMIT {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
    }

    /// The text changed: only `selections` remain.
    pub(crate) fn reset(&mut self, selections: &Selections) {
        self.undo.clear();
        self.redo.clear();
        self.current = Some(selections.clone());
    }

    /// The selections before the current ones, which become a step forward.
    pub(crate) fn undo(&mut self) -> Option<Selections> {
        let previous = self.undo.pop()?;
        if let Some(current) = self.current.replace(previous.clone()) {
            self.redo.push(current);
        }
        Some(previous)
    }

    /// The selections `undo` went back from.
    pub(crate) fn redo(&mut self) -> Option<Selections> {
        let next = self.redo.pop()?;
        if let Some(current) = self.current.replace(next.clone()) {
            self.undo.push(current);
        }
        Some(next)
    }
}

/// What `expandSelection` grew from, so `shrinkSelection` goes back the
/// same way; anything else changing the selections ends it.
#[derive(Debug, Default)]
pub(crate) struct ExpandStack {
    stack: Vec<Selections>,
    /// The selections the last expansion made.
    top: Option<Selections>,
}

impl ExpandStack {
    /// `from` grew into `to`.
    pub(crate) fn push(&mut self, from: &Selections, to: &Selections) {
        if self.top.as_ref() != Some(from) {
            self.stack.clear();
        }
        self.stack.push(from.clone());
        self.top = Some(to.clone());
    }

    /// What `current` grew from, when it is what the last expansion made.
    pub(crate) fn pop(&mut self, current: &Selections) -> Option<Selections> {
        if self.top.as_ref() != Some(current) {
            self.stack.clear();
            self.top = None;
            return None;
        }
        let previous = self.stack.pop()?;
        self.top = Some(previous.clone());
        Some(previous)
    }
}

/// The smallest unit around `range` that is larger than it (see the module's
/// doc); None when `range` is the whole text.
pub(crate) fn expand(
    buffer: &Buffer,
    language: &LanguageConfig,
    range: Range<usize>,
) -> Option<Range<usize>> {
    let (first, last) = (buffer.line_of(range.start), buffer.line_of(range.end));
    let mut units: Vec<Range<usize>> = Vec::with_capacity(8);
    if first == last {
        units.push(movement::word_range(
            buffer,
            range.start,
            language.word_chars,
        ));
        if let Some((open, close)) = enclosing_quotes(buffer, language, range.clone()) {
            let len = buffer.char_at(close).map_or(1, char::len_utf8);
            units.push(open + len..close);
            units.push(open..close + len);
        }
    }
    if let Some((open, close)) =
        movement::enclosing_brackets(buffer, range.clone(), language.brackets)
    {
        let open_len = buffer.char_at(open).map_or(1, char::len_utf8);
        let close_len = buffer.char_at(close).map_or(1, char::len_utf8);
        units.push(open + open_len..close);
        units.push(open..close + close_len);
    }
    units.push(movement::first_non_blank(buffer, first)..buffer.line_end(last));
    let after_last = if last + 1 < buffer.line_count() {
        buffer.line_start(last + 1)
    } else {
        buffer.len()
    };
    units.push(buffer.line_start(first)..after_last);
    units.push(0..buffer.len());
    units
        .into_iter()
        .filter(|unit| {
            unit.start <= range.start && range.end <= unit.end && unit.len() > range.len()
        })
        .min_by_key(|unit| unit.len())
}

/// The quotes around `range` on its line (offsets of the opening and the
/// closing one): the language's string quotes, paired from the line's
/// start, a backslash escaping the char after it. The innermost when
/// several kinds enclose it.
fn enclosing_quotes(
    buffer: &Buffer,
    language: &LanguageConfig,
    range: Range<usize>,
) -> Option<(usize, usize)> {
    let line = buffer.line_of(range.start);
    let line_start = buffer.line_start(line);
    let text = buffer.line_text(line);
    let (from, to) = (range.start - line_start, range.end - line_start);
    let mut best: Option<(usize, usize)> = None;
    for quote in language.string_quotes.chars() {
        let mut opened = None;
        let mut escaped = false;
        for (i, c) in text.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if c == '\\' {
                escaped = true;
                continue;
            }
            if c != quote {
                continue;
            }
            let Some(o) = opened.take() else {
                opened = Some(i);
                continue;
            };
            let encloses = o <= from && to <= i + c.len_utf8();
            if encloses && best.is_none_or(|(bo, bc)| i - o < bc - bo) {
                best = Some((o, i));
            }
        }
    }
    best.map(|(o, c)| (line_start + o, line_start + c))
}

/// Each selection expanded ([`expand`]); None when none of them grows.
pub(crate) fn expand_all(
    buffer: &Buffer,
    language: &LanguageConfig,
    selections: &Selections,
) -> Option<Selections> {
    let mut grew = false;
    let all = selections
        .all()
        .iter()
        .map(|&s| match expand(buffer, language, s.range()) {
            Some(unit) => {
                grew = true;
                Selection::new(unit.start, unit.end)
            }
            None => s,
        })
        .collect();
    grew.then(|| Selections::new(all, selections.primary_index()))
}

/// A block selection: one selection per display row from `anchor`'s row to
/// `head`'s, each from `anchor`'s x to `head`'s (less the row's `indent`),
/// so the block keeps its columns past the end of short rows, which select
/// what they have. The selection on `head`'s row is primary.
pub(crate) fn block(
    layout: &dyn RowLayout,
    anchor: (usize, Points),
    head: (usize, Points),
    indent: &dyn Fn(usize) -> Points,
) -> Selections {
    let last = layout.row_count().saturating_sub(1);
    let (top, bottom) = (
        anchor.0.min(head.0).min(last),
        anchor.0.max(head.0).min(last),
    );
    let all: Vec<Selection> = (top..=bottom)
        .map(|row| {
            let at = |x: Points| layout.offset_at(row, (x - indent(row)).max(px(0.0)));
            Selection::new(at(anchor.1), at(head.1))
        })
        .collect();
    let primary = if head.0 >= anchor.0 { all.len() - 1 } else { 0 };
    Selections::new(all, primary)
}

impl State {
    /// The block selection dragged from `from` to `to`, points of the rows'
    /// box.
    pub(crate) fn block_selection(&self, from: Pt<Points>, to: Pt<Points>) -> Selections {
        let lh = self.line_height().0.max(1.0);
        let rows = self.display.row_count();
        let row_of = |y: Points| ((y.0 / lh).floor().max(0.0) as usize).min(rows.saturating_sub(1));
        let before = self.buffer.snapshot();
        let layout = self.display.layout(&before);
        let indent = |row: usize| self.display.row(row).indent;
        block(
            &layout,
            (row_of(from.y), from.x),
            (row_of(to.y), to.x),
            &indent,
        )
    }

    /// Takes the app's `search`: a search `in_selection` keeps the scope it
    /// started with (the selections then, or the carets' lines) while it
    /// stays in the selection, carried through edits.
    pub(crate) fn set_search(&mut self, search: Option<EditorSearch>) {
        let scoped = search.as_ref().is_some_and(|s| s.in_selection);
        let was_scoped = self.search.as_ref().is_some_and(|s| s.in_selection);
        if !scoped {
            self.search_scope = None;
        } else if !was_scoped || self.search_scope.is_none() {
            self.search_scope = Some(scope_of(&self.buffer, &self.selections));
        }
        self.search = search;
        self.find();
    }
}

/// What a search in `selections` searches: what they select, or the lines
/// of the carets when nothing is selected.
fn scope_of(buffer: &Buffer, selections: &Selections) -> Vec<Mark<()>> {
    let selected: Vec<Range<usize>> = selections
        .all()
        .iter()
        .filter(|s| !s.is_empty())
        .map(Selection::range)
        .collect();
    let ranges = if selected.is_empty() {
        selections
            .all()
            .iter()
            .map(|s| {
                let line = buffer.line_of(s.head);
                buffer.line_start(line)..buffer.line_end(line)
            })
            .collect()
    } else {
        selected
    };
    ranges
        .into_iter()
        .map(|range| Mark { range, item: () })
        .collect()
}

impl Ed {
    /// Back to the selections before the last move (`undo`), or forward
    /// again.
    pub(crate) fn undo_selection(&self, undo: bool) {
        let restored = {
            let mut history = self.sel_history.borrow_mut();
            if undo { history.undo() } else { history.redo() }
        };
        let Some(mut selections) = restored else {
            return;
        };
        {
            let mut st = self.st.borrow_mut();
            selections.clamp(st.buffer.len());
            st.selections = selections;
        }
        self.after(Outcome::Moved);
    }

    /// Grows every selection by a unit (`grow`), or back to what it grew
    /// from.
    pub(crate) fn expand_selection(&self, grow: bool) {
        let next = {
            let st = self.st.borrow();
            let mut expansions = self.expansions.borrow_mut();
            if grow {
                let next = expand_all(&st.buffer, st.language, &st.selections);
                if let Some(next) = &next {
                    expansions.push(&st.selections, next);
                }
                next
            } else {
                expansions.pop(&st.selections)
            }
        };
        let Some(next) = next else { return };
        self.st.borrow_mut().selections = next;
        self.after(Outcome::Moved);
    }

    /// Reports the primary selection's text (a caret: its word) for the
    /// app's find bar to search (`onFindWithSelection`).
    pub(crate) fn find_with_selection(&self) {
        let query = {
            let st = self.st.borrow();
            let primary = st.selections.primary();
            let range = if primary.is_empty() {
                movement::word_range(&st.buffer, primary.head, st.language.word_chars)
            } else {
                primary.range()
            };
            st.buffer.slice(range)
        };
        if query.trim().is_empty() {
            return;
        }
        self.cx.emit(EditorEvent::FindWithSelection(query));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        super::language::{self, PLAIN_TEXT},
        *,
    };

    /// One row per line, every char 10 points wide.
    struct Rows {
        lines: Vec<(usize, String)>,
    }

    impl Rows {
        fn new(buffer: &Buffer) -> Rows {
            Rows {
                lines: (0..buffer.line_count())
                    .map(|line| (buffer.line_start(line), buffer.line_text(line)))
                    .collect(),
            }
        }
    }

    impl RowLayout for Rows {
        fn row_count(&self) -> usize {
            self.lines.len()
        }

        fn locate(&self, offset: usize) -> (usize, Points) {
            let row = self
                .lines
                .partition_point(|(start, _)| *start <= offset)
                .saturating_sub(1);
            let (start, text) = &self.lines[row];
            let column = offset.saturating_sub(*start).min(text.len());
            (row, px(text[..column].chars().count() as f32 * 10.0))
        }

        fn offset_at(&self, row: usize, x: Points) -> usize {
            let (start, text) = &self.lines[row.min(self.lines.len() - 1)];
            let n = (x.0 / 10.0).round().max(0.0) as usize;
            start + text.char_indices().nth(n).map_or(text.len(), |(i, _)| i)
        }

        fn row_range(&self, row: usize) -> Range<usize> {
            let (start, text) = &self.lines[row.min(self.lines.len() - 1)];
            *start..start + text.len()
        }
    }

    fn ranges(selections: &Selections) -> Vec<Range<usize>> {
        selections.all().iter().map(Selection::range).collect()
    }

    #[test]
    fn blocks_keep_their_columns_past_short_rows() {
        // Lines start at 0, 7, 9, 16.
        let buffer = Buffer::new("abcdef\nx\nabcdef\n日本語");
        let rows = Rows::new(&buffer);
        let none = |_: usize| Points::ZERO;
        let s = block(&rows, (0, px(10.0)), (2, px(40.0)), &none);
        assert_eq!(ranges(&s), vec![1..4, 8..8, 10..13]);
        assert_eq!(s.primary_index(), 2);
        assert!(s.all().iter().all(|s| !s.is_reversed()));
        // Dragged up and to the left: reversed, the top row primary.
        let s = block(&rows, (3, px(30.0)), (2, px(10.0)), &none);
        assert_eq!(ranges(&s), vec![10..12, 19..25]);
        assert_eq!(s.primary_index(), 0);
        assert!(s.all().iter().all(Selection::is_reversed));
        // One row; rows past the last clamp.
        let s = block(&rows, (1, px(0.0)), (9, px(0.0)), &none);
        assert_eq!(ranges(&s), vec![7..7, 9..9, 16..16]);
        // A row's indent moves its columns.
        let indent = |row: usize| if row == 1 { px(10.0) } else { Points::ZERO };
        let s = block(&rows, (0, px(20.0)), (1, px(20.0)), &indent);
        assert_eq!(ranges(&s), vec![2..2, 8..8]);
    }

    #[test]
    fn expanding_grows_unit_by_unit() {
        let rust = language::language("rust");
        let buffer = Buffer::new("fn f() {\n    g(\"ab cd\", [x]);\n}");
        let grow = |range: Range<usize>| expand(&buffer, rust, range);
        // From a caret in `ab`: the word, the string's contents, the
        // string, the call's arguments, the call's brackets, the line's
        // text, the line, the braces' contents, the braces, the text.
        let mut range = 16..16;
        let mut steps = Vec::new();
        while let Some(next) = grow(range.clone()) {
            steps.push(buffer.slice(next.clone()));
            range = next;
        }
        assert_eq!(
            steps,
            vec![
                "ab",
                "ab cd",
                "\"ab cd\"",
                "\"ab cd\", [x]",
                "(\"ab cd\", [x])",
                "g(\"ab cd\", [x]);",
                "    g(\"ab cd\", [x]);\n",
                "\n    g(\"ab cd\", [x]);\n",
                "{\n    g(\"ab cd\", [x]);\n}",
                "fn f() {\n    g(\"ab cd\", [x]);\n}",
            ]
        );
        assert_eq!(grow(0..buffer.len()), None);
        // Inside brackets of their own.
        assert_eq!(grow(25..26), Some(24..27));
        let empty = Buffer::new("");
        assert_eq!(expand(&empty, &PLAIN_TEXT, 0..0), None);
    }

    #[test]
    fn quotes_pair_from_the_line_start_and_escape() {
        let rust = language::language("rust");
        let buffer = Buffer::new(r#"a "b\"c" "d""#);
        assert_eq!(enclosing_quotes(&buffer, rust, 4..4), Some((2, 7)));
        assert_eq!(enclosing_quotes(&buffer, rust, 10..10), Some((9, 11)));
        // Before the first string: none; right after one: that one.
        assert_eq!(enclosing_quotes(&buffer, rust, 1..1), None);
        assert_eq!(enclosing_quotes(&buffer, rust, 8..8), Some((2, 7)));
        assert_eq!(enclosing_quotes(&buffer, &PLAIN_TEXT, 4..4), None);
    }

    #[test]
    fn several_selections_expand_together() {
        let buffer = Buffer::new("ab cd");
        let selections = Selections::new(vec![Selection::caret(1), Selection::caret(4)], 1);
        let grown = expand_all(&buffer, &PLAIN_TEXT, &selections).unwrap();
        assert_eq!(ranges(&grown), vec![0..2, 3..5]);
        assert_eq!(grown.primary_index(), 1);
        let all = Selections::single(Selection::new(0, 5));
        assert_eq!(expand_all(&buffer, &PLAIN_TEXT, &all), None);
    }

    #[test]
    fn shrinking_retraces_the_expansions() {
        let a = Selections::single(Selection::caret(1));
        let b = Selections::single(Selection::new(0, 2));
        let c = Selections::single(Selection::new(0, 5));
        let mut stack = ExpandStack::default();
        stack.push(&a, &b);
        stack.push(&b, &c);
        assert_eq!(stack.pop(&c), Some(b.clone()));
        assert_eq!(stack.pop(&b), Some(a.clone()));
        assert_eq!(stack.pop(&a), None);
        // Another selection in between ends it.
        stack.push(&a, &b);
        assert_eq!(stack.pop(&c), None);
        assert_eq!(stack.pop(&b), None);
    }

    #[test]
    fn the_history_goes_back_and_forth() {
        let at = |offset| Selections::single(Selection::caret(offset));
        let mut history = SelectionHistory::new(&at(0));
        history.record(&at(1));
        history.record(&at(1));
        history.record(&at(2));
        assert_eq!(history.undo(), Some(at(1)));
        assert_eq!(history.undo(), Some(at(0)));
        assert_eq!(history.undo(), None);
        assert_eq!(history.redo(), Some(at(1)));
        // Restoring records nothing new; a new move drops the steps forward.
        history.record(&at(1));
        assert_eq!(history.redo(), Some(at(2)));
        history.undo();
        history.record(&at(5));
        assert_eq!(history.redo(), None);
        assert_eq!(history.undo(), Some(at(1)));
        history.reset(&at(3));
        assert_eq!(history.undo(), None);
        for offset in 0..HISTORY_LIMIT + 10 {
            history.record(&at(offset + 10));
        }
        let mut steps = 0;
        while history.undo().is_some() {
            steps += 1;
        }
        assert_eq!(steps, HISTORY_LIMIT);
    }

    #[test]
    fn search_scope_of_selections_or_lines() {
        let buffer = Buffer::new("ab\ncd");
        let carets = Selections::new(vec![Selection::caret(1), Selection::caret(4)], 0);
        let scope: Vec<Range<usize>> = scope_of(&buffer, &carets)
            .into_iter()
            .map(|m| m.range)
            .collect();
        assert_eq!(scope, vec![0..2, 3..5]);
        let mixed = Selections::new(vec![Selection::caret(1), Selection::new(4, 3)], 0);
        let scope: Vec<Range<usize>> = scope_of(&buffer, &mixed)
            .into_iter()
            .map(|m| m.range)
            .collect();
        assert_eq!(scope, vec![3..4]);
    }
}
