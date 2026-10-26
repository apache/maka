//! Editing commands: what a key binding, typing or pasting does, at every
//! selection at once (multi-cursor).
//!
//! A command gathers its edits as ranges of the text as it is, each with
//! where its selections go ([`Plan`]), then applies them in one
//! `Buffer::edit` (one undo step). Selections are placed either inside the
//! text an edit inserts or by carrying an old offset through all the
//! edits, so they land right however many edits come before them.

use std::ops::Range;

use super::{
    buffer::{Bias, Buffer, Change, EditKind},
    language::LanguageConfig,
    movement,
    types::{Point, RowLayout, Selection, Selections},
};

mod selecting;
mod transforms;

pub(crate) use transforms::Case;

/// How the editor edits: the app's options, the language's defaults
/// applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EditOptions {
    /// Columns of an indentation level and between tab stops.
    pub(crate) tab_size: u32,
    /// Indent with tabs instead of spaces.
    pub(crate) hard_tabs: bool,
    /// Typing an opening bracket or quote closes it.
    pub(crate) auto_close: bool,
    /// New lines and closing brackets follow the code's indentation.
    pub(crate) auto_indent: bool,
    /// Nothing edits the text; moves and selection still work.
    pub(crate) read_only: bool,
}

impl Default for EditOptions {
    fn default() -> Self {
        EditOptions {
            tab_size: 4,
            hard_tabs: false,
            auto_close: true,
            auto_indent: true,
            read_only: false,
        }
    }
}

/// What the editor's state is for one command.
pub(crate) struct Editing<'a> {
    /// The text.
    pub(crate) buffer: &'a mut Buffer,
    /// The selections, which the command moves.
    pub(crate) selections: &'a mut Selections,
    /// The language's editing rules.
    pub(crate) language: &'static LanguageConfig,
    /// The editor's options.
    pub(crate) options: &'a EditOptions,
    /// The layout before the command (vertical moves, rows).
    pub(crate) layout: &'a dyn RowLayout,
    /// Rows a page moves.
    pub(crate) page_rows: usize,
}

/// A command a key binding runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Command {
    /// One grapheme left; a selection collapses to its start.
    Left { select: bool },
    /// One grapheme right; a selection collapses to its end.
    Right { select: bool },
    /// One row up, keeping the column.
    Up { select: bool },
    /// One row down, keeping the column.
    Down { select: bool },
    /// To the start of the previous word.
    WordLeft { select: bool },
    /// Past the end of the next word.
    WordRight { select: bool },
    /// Home: the first non-blank, then the line's start.
    LineStart { select: bool },
    /// End: the row's end, then the line's.
    LineEnd { select: bool },
    /// A page of rows up.
    PageUp { select: bool },
    /// A page of rows down.
    PageDown { select: bool },
    /// To the start of the text.
    DocumentStart { select: bool },
    /// To the end of the text.
    DocumentEnd { select: bool },
    /// To the bracket matching the one at the caret.
    MatchingBracket,
    /// The whole text.
    SelectAll,
    /// Each selection grows to whole lines, then by a line each time.
    SelectLine,
    /// Each caret selects its word.
    SelectWord,
    /// Selects the next occurrence of the primary selection's text (its word
    /// when it is a caret).
    SelectNextOccurrence,
    /// Selects every occurrence of the primary selection's text.
    SelectAllOccurrences,
    /// A new caret on the row above the primary one.
    AddCaretAbove,
    /// A new caret on the row below the primary one.
    AddCaretBelow,
    /// Escape: back to the primary selection, else collapses it.
    SingleSelection,
    /// Deletes the selection or what is before the caret (an indentation
    /// level in leading spaces, an empty auto-closed pair).
    Backspace,
    /// Deletes the selection or what is after the caret.
    Delete,
    /// Deletes to the start of the previous word.
    DeleteWordLeft,
    /// Deletes past the end of the next word.
    DeleteWordRight,
    /// Deletes to the line's start (at its start, the line break).
    DeleteToLineStart,
    /// Deletes to the line's end (at its end, the line break).
    DeleteToLineEnd,
    /// Deletes the selected lines.
    DeleteLine,
    /// A line break, indented.
    Newline,
    /// A new line below the caret's, the caret on it.
    NewlineBelow,
    /// A new line above the caret's, the caret on it.
    NewlineAbove,
    /// Tab: to the next tab stop, or the selected lines a level in.
    Indent,
    /// Shift+Tab: the selected lines a level out.
    Outdent,
    /// Comments the selected lines out, or back in.
    ToggleComment,
    /// The selected lines swap with the line above.
    MoveLinesUp,
    /// The selected lines swap with the line below.
    MoveLinesDown,
    /// The selected lines copied above, the selections staying on the upper
    /// copy.
    DuplicateLinesUp,
    /// The selected lines copied below, the selections moving to the copy.
    DuplicateLinesDown,
    /// The selected lines (or the caret's and the next) joined by a space.
    JoinLines,
    /// Swaps the graphemes around the caret (at a line's end, the two
    /// before it).
    TransposeChars,
    /// Undoes the last edit, restoring its selections.
    Undo,
    /// Redoes the last undone edit, restoring its selections.
    Redo,
    /// Selects the previous occurrence of the primary selection's text (its
    /// word when it is a caret).
    SelectPreviousOccurrence,
    /// To the start of the previous part of a word (camelCase, snake_case).
    SubwordLeft { select: bool },
    /// Past the end of the next part of a word.
    SubwordRight { select: bool },
    /// To the blank line before the paragraph.
    ParagraphUp { select: bool },
    /// To the blank line after the paragraph.
    ParagraphDown { select: bool },
    /// Sorts the selected lines (every line when there is only a caret).
    SortLines { descending: bool },
    /// Changes the case of the selections (a caret: its word).
    ChangeCase(Case),
    /// Removes the blanks at the end of every line.
    TrimTrailingWhitespace,
    /// Wraps each selection in the language's block comment, or unwraps it.
    ToggleBlockComment,
    /// Each selection over several lines becomes one per line.
    SplitSelectionIntoLines,
}

/// What a command did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Nothing changed.
    Nothing,
    /// Only the selections changed.
    Moved,
    /// The text changed (and the selections may have): the changes applied.
    Edited(Vec<Change>),
}

/// Where a selection's end goes after a plan's edits.
#[derive(Debug, Clone, Copy)]
enum Place {
    /// An offset of the text before the edits, carried through them.
    Old(usize, Bias),
    /// Bytes into the text edit `.0` (an index into [`Plan::edits`])
    /// inserts.
    New(usize, usize),
}

/// The edits of one command and where its selections go.
struct Plan {
    /// Ranges of the text as it is and their replacements, in any order;
    /// overlapping ones merge (their texts joined) and equal ones count once.
    edits: Vec<(Range<usize>, String)>,
    /// The new selections: anchor and head.
    selections: Vec<(Place, Place)>,
    /// Which of them is primary.
    primary: usize,
}

impl Plan {
    fn new(primary: usize) -> Plan {
        Plan {
            edits: Vec::new(),
            selections: Vec::new(),
            primary,
        }
    }

    fn edit(&mut self, range: Range<usize>, text: impl Into<String>) -> usize {
        self.edits.push((range, text.into()));
        self.edits.len() - 1
    }

    fn select(&mut self, anchor: Place, head: Place) {
        self.selections.push((anchor, head));
    }

    fn caret(&mut self, at: Place) {
        self.selections.push((at, at));
    }

    /// `selection` carried through the edits: a caret after what is
    /// inserted at it, a selection growing over what is inserted at its
    /// ends.
    fn follow(&mut self, selection: Selection) {
        if selection.is_empty() {
            self.caret(Place::Old(selection.head, Bias::Right));
            return;
        }
        let start = Place::Old(selection.start(), Bias::Left);
        let end = Place::Old(selection.end(), Bias::Right);
        if selection.is_reversed() {
            self.select(end, start);
        } else {
            self.select(start, end);
        }
    }

    /// A selection of `len` bytes of edit `index`'s text from `at`,
    /// backwards when `reversed`.
    fn select_inside(&mut self, index: usize, at: usize, len: usize, reversed: bool) {
        let (start, end) = (Place::New(index, at), Place::New(index, at + len));
        if reversed {
            self.select(end, start);
        } else {
            self.select(start, end);
        }
    }
}

/// A run of whole lines one or more selections touch, with those
/// selections (what line commands act on).
struct Block {
    first: usize,
    last: usize,
    selections: Vec<Selection>,
}

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// The spaces and tabs `line` starts with.
fn leading_whitespace(line: &str) -> &str {
    &line[..line.len() - line.trim_start_matches(is_blank).len()]
}

/// The column at the end of `text` with tabs advancing to the next stop.
fn visual_column(text: &str, tab: usize) -> usize {
    text.chars().fold(0, |column, c| {
        if c == '\t' {
            column + tab - column % tab
        } else {
            column + 1
        }
    })
}

/// Line breaks as the buffer keeps them (`\n`).
fn normalize(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_owned()
    }
}

impl Editing<'_> {
    /// Runs `command` at every selection.
    pub(crate) fn run(&mut self, command: Command) -> Outcome {
        use Command::*;
        let outcome = match command {
            Left { select } => self.move_each(select, |cx, s| {
                if !select && !s.is_empty() {
                    s.start()
                } else {
                    movement::prev_grapheme(cx.buffer, s.head)
                }
            }),
            Right { select } => self.move_each(select, |cx, s| {
                if !select && !s.is_empty() {
                    s.end()
                } else {
                    movement::next_grapheme(cx.buffer, s.head)
                }
            }),
            Up { select } => self.vertical(select, -1),
            Down { select } => self.vertical(select, 1),
            PageUp { select } => self.vertical(select, -(self.page_rows.max(1) as isize)),
            PageDown { select } => self.vertical(select, self.page_rows.max(1) as isize),
            WordLeft { select } => self.move_each(select, |cx, s| {
                movement::prev_word_start(cx.buffer, s.head, cx.language.word_chars)
            }),
            WordRight { select } => self.move_each(select, |cx, s| {
                movement::next_word_end(cx.buffer, s.head, cx.language.word_chars)
            }),
            LineStart { select } => self.move_each(select, |cx, s| {
                movement::smart_home(cx.buffer, cx.layout, s.head)
            }),
            LineEnd { select } => self.move_each(select, |cx, s| {
                movement::smart_end(cx.buffer, cx.layout, s.head)
            }),
            DocumentStart { select } => self.move_each(select, |_, _| 0),
            DocumentEnd { select } => self.move_each(select, |cx, _| cx.buffer.len()),
            MatchingBracket => self.move_each(false, |cx, s| {
                match movement::matching_bracket(cx.buffer, s.head, cx.language.brackets) {
                    // Near the opening bracket: to the closing one, and back.
                    Some((open, close)) if s.head <= open + 1 => close,
                    Some((open, _)) => open,
                    None => s.head,
                }
            }),
            SelectAll => self.set_selections(vec![Selection::new(0, self.buffer.len())], 0),
            SelectLine => self.select_lines(),
            SelectWord => self.select_words(),
            SelectNextOccurrence => self.select_next_occurrence(),
            SelectAllOccurrences => self.select_all_occurrences(),
            AddCaretAbove => self.add_caret(-1),
            AddCaretBelow => self.add_caret(1),
            SingleSelection => self.single_selection(),
            Backspace => self.delete_each(EditKind::Deleting, Self::backspace_range),
            Delete => self.delete_each(EditKind::Deleting, |cx, head| {
                head..movement::next_grapheme(cx.buffer, head)
            }),
            DeleteWordLeft => self.delete_each(EditKind::Deleting, |cx, head| {
                movement::prev_word_start(cx.buffer, head, cx.language.word_chars)..head
            }),
            DeleteWordRight => self.delete_each(EditKind::Deleting, |cx, head| {
                head..movement::next_word_end(cx.buffer, head, cx.language.word_chars)
            }),
            DeleteToLineStart => self.delete_each(EditKind::Other, |cx, head| {
                let start = cx.buffer.line_start(cx.buffer.line_of(head));
                if head == start {
                    movement::prev_grapheme(cx.buffer, head)..head
                } else {
                    start..head
                }
            }),
            DeleteToLineEnd => self.delete_each(EditKind::Other, |cx, head| {
                let end = cx.buffer.line_end(cx.buffer.line_of(head));
                if head == end {
                    head..movement::next_grapheme(cx.buffer, head)
                } else {
                    head..end
                }
            }),
            DeleteLine => self.delete_lines(),
            Newline => self.newline(),
            NewlineBelow => self.newline_below(),
            NewlineAbove => self.newline_above(),
            Indent => self.indent(),
            Outdent => self.outdent(),
            ToggleComment => self.toggle_comment(),
            MoveLinesUp => self.move_lines(false),
            MoveLinesDown => self.move_lines(true),
            DuplicateLinesUp => self.duplicate_lines(false),
            DuplicateLinesDown => self.duplicate_lines(true),
            JoinLines => self.join_lines(),
            TransposeChars => self.transpose(),
            Undo => self.history(true),
            Redo => self.history(false),
            SelectPreviousOccurrence => self.select_previous_occurrence(),
            SubwordLeft { select } => self.move_each(select, |cx, s| {
                movement::prev_subword_start(cx.buffer, s.head, cx.language.word_chars)
            }),
            SubwordRight { select } => self.move_each(select, |cx, s| {
                movement::next_subword_end(cx.buffer, s.head, cx.language.word_chars)
            }),
            ParagraphUp { select } => {
                self.move_each(select, |cx, s| movement::prev_paragraph(cx.buffer, s.head))
            }
            ParagraphDown { select } => {
                self.move_each(select, |cx, s| movement::next_paragraph(cx.buffer, s.head))
            }
            SortLines { descending } => self.sort_lines(descending),
            ChangeCase(case) => self.change_case(case),
            TrimTrailingWhitespace => self.trim_trailing_whitespace(),
            ToggleBlockComment => self.toggle_block_comments(),
            SplitSelectionIntoLines => self.split_into_lines(),
        };
        let vertical = matches!(
            command,
            Up { .. }
                | Down { .. }
                | PageUp { .. }
                | PageDown { .. }
                | AddCaretAbove
                | AddCaretBelow
        );
        if !vertical && self.selections.all().iter().any(|s| s.goal.is_some()) {
            self.selections.map(|s| Selection { goal: None, ..s });
        }
        outcome
    }

    /// Typed (or IME-committed) text at every selection: a single "\n" runs
    /// `Newline`; one char of `language.auto_close` opens and closes a pair
    /// (or wraps a non-empty selection); typing a closing char right before
    /// the same char steps over it; a closing bracket typed on a blank line
    /// outdents it.
    pub(crate) fn insert(&mut self, text: &str) -> Outcome {
        if self.options.read_only || text.is_empty() {
            return Outcome::Nothing;
        }
        let text = normalize(text);
        if text == "\n" {
            return self.newline();
        }
        let mut chars = text.chars();
        let single = match (chars.next(), chars.next()) {
            (Some(c), None) => Some(c),
            _ => None,
        };
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            if let Some(c) = single
                && self.typed_char(&mut plan, s, c)
            {
                continue;
            }
            let i = plan.edit(s.range(), text.as_str());
            plan.caret(Place::New(i, text.len()));
        }
        self.commit(plan, EditKind::Typing)
    }

    /// Pastes `text`: one line per selection when the counts match;
    /// `line_wise` text (copied from carets) goes in as whole lines above
    /// each caret's line.
    pub(crate) fn paste(&mut self, text: &str, line_wise: bool) -> Outcome {
        if self.options.read_only || text.is_empty() {
            return Outcome::Nothing;
        }
        let text = normalize(text);
        let selections = self.selections.clone();
        let count = selections.len();
        let mut plan = Plan::new(selections.primary_index());
        if line_wise && selections.all().iter().all(Selection::is_empty) {
            let mut whole = text.clone();
            if !whole.ends_with('\n') {
                whole.push('\n');
            }
            let pieces: Vec<&str> = whole.split_inclusive('\n').collect();
            let spread = count > 1 && pieces.len() == count;
            for (k, s) in selections.all().iter().enumerate() {
                let start = self.buffer.line_start(self.buffer.line_of(s.head));
                let piece = if spread { pieces[k] } else { whole.as_str() };
                plan.edit(start..start, piece);
                plan.caret(Place::Old(s.head, Bias::Right));
            }
            return self.commit(plan, EditKind::Other);
        }
        let body = text.strip_suffix('\n').unwrap_or(&text);
        let lines: Vec<&str> = body.split('\n').collect();
        let spread = count > 1 && lines.len() == count;
        for (k, s) in selections.all().iter().enumerate() {
            let piece = if spread { lines[k] } else { text.as_str() };
            let i = plan.edit(s.range(), piece);
            plan.caret(Place::New(i, piece.len()));
        }
        self.commit(plan, EditKind::Other)
    }

    /// What copying gives: the selections joined by "\n"; when all are
    /// carets, their whole lines (`line_wise`).
    pub(crate) fn copy(&self) -> (String, bool) {
        let all = self.selections.all();
        if all.iter().all(Selection::is_empty) {
            let mut text = String::new();
            for block in self.blocks(&*self.selections) {
                text.push_str(
                    &self.buffer.slice(
                        self.buffer.line_start(block.first)..self.buffer.line_end(block.last),
                    ),
                );
                text.push('\n');
            }
            return (text, true);
        }
        let texts: Vec<String> = all
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| self.buffer.slice(s.range()))
            .collect();
        (texts.join("\n"), false)
    }

    /// Copy, then delete what was copied (whole lines for carets).
    pub(crate) fn cut(&mut self) -> (String, bool, Outcome) {
        let (text, line_wise) = self.copy();
        if self.options.read_only {
            return (text, line_wise, Outcome::Nothing);
        }
        let outcome = if line_wise {
            self.delete_lines()
        } else {
            let selections = self.selections.clone();
            let mut plan = Plan::new(selections.primary_index());
            for &s in selections.all() {
                if s.is_empty() {
                    plan.follow(s);
                } else {
                    let i = plan.edit(s.range(), "");
                    plan.caret(Place::New(i, 0));
                }
            }
            self.commit(plan, EditKind::Other)
        };
        (text, line_wise, outcome)
    }

    /// Replaces `ranges` (sorted, not overlapping) with their texts as one
    /// undo step; the selections follow.
    pub(crate) fn replace(&mut self, ranges: Vec<(Range<usize>, String)>) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for (range, text) in ranges {
            let range = self.buffer.clip(range.start)..self.buffer.clip(range.end);
            plan.edit(range, normalize(&text));
        }
        for &s in selections.all() {
            plan.follow(s);
        }
        self.commit(plan, EditKind::Other)
    }

    // Applying plans.

    /// Applies `plan`'s edits as one undo step and places its selections.
    fn commit(&mut self, plan: Plan, kind: EditKind) -> Outcome {
        let Plan {
            edits,
            selections,
            primary,
        } = plan;
        let mut order: Vec<usize> = (0..edits.len()).collect();
        order.sort_by_key(|&i| (edits[i].0.start, edits[i].0.end));
        let mut merged: Vec<(Range<usize>, String)> = Vec::with_capacity(edits.len());
        // Each edit's merged edit and the bytes of the merged text before its own.
        let mut at = vec![(0, 0); edits.len()];
        for i in order {
            let (range, text) = &edits[i];
            let len = merged.len();
            if let Some((last_range, last_text)) = merged.last_mut() {
                if last_range == range && last_text == text {
                    // Several carets on one line asking for the same edit.
                    at[i] = (len - 1, 0);
                    continue;
                }
                let overlaps = range.start < last_range.end
                    || (last_range.start == last_range.end && range.start == last_range.start);
                if overlaps {
                    at[i] = (len - 1, last_text.len());
                    last_text.push_str(text);
                    last_range.end = last_range.end.max(range.end);
                    continue;
                }
            }
            at[i] = (merged.len(), 0);
            merged.push((range.clone(), text.clone()));
        }

        let mut starts = Vec::with_capacity(merged.len());
        let mut delta = 0isize;
        for (range, text) in &merged {
            starts.push(range.start.wrapping_add_signed(delta));
            delta += text.len() as isize - range.len() as isize;
        }
        let new_len = self.buffer.len().wrapping_add_signed(delta);
        let place = |place: Place| -> usize {
            let offset = match place {
                Place::New(i, rel) => {
                    let (m, before) = at[i];
                    starts[m] + before + rel
                }
                Place::Old(offset, bias) => {
                    let mut shift = 0isize;
                    for (k, (range, text)) in merged.iter().enumerate() {
                        let before = range.end < offset
                            || (range.end == offset
                                && (range.start < offset || bias == Bias::Right));
                        if before {
                            shift = (starts[k] + text.len()) as isize - range.end as isize;
                            continue;
                        }
                        if range.start < offset {
                            return match bias {
                                Bias::Left => starts[k],
                                Bias::Right => starts[k] + text.len(),
                            };
                        }
                        break;
                    }
                    offset.wrapping_add_signed(shift)
                }
            };
            offset.min(new_len)
        };
        let after = Selections::new(
            selections
                .into_iter()
                .map(|(anchor, head)| Selection::new(place(anchor), place(head)))
                .collect(),
            primary,
        );

        let edits: Vec<(Range<usize>, String)> = merged
            .into_iter()
            .filter(|(range, text)| !(range.is_empty() && text.is_empty()))
            .collect();
        if edits.is_empty() || self.options.read_only {
            return self.replace_selections(after);
        }
        let before = self.selections.clone();
        let changes = self.buffer.edit(edits, &before, &after, kind);
        *self.selections = after;
        if !changes.is_empty() {
            Outcome::Edited(changes)
        } else if *self.selections != before {
            Outcome::Moved
        } else {
            Outcome::Nothing
        }
    }

    fn replace_selections(&mut self, selections: Selections) -> Outcome {
        if selections == *self.selections {
            Outcome::Nothing
        } else {
            *self.selections = selections;
            Outcome::Moved
        }
    }

    fn set_selections(&mut self, all: Vec<Selection>, primary: usize) -> Outcome {
        self.replace_selections(Selections::new(all, primary))
    }

    // Moves and selection.

    /// Each selection's head moved to what `to` gives (extending the
    /// selection with `select`, else a caret there).
    fn move_each(&mut self, select: bool, to: impl Fn(&Self, Selection) -> usize) -> Outcome {
        let selections = self.selections.clone();
        let cx: &Self = self;
        let all = selections
            .all()
            .iter()
            .map(|&s| {
                let head = to(cx, s);
                if select {
                    s.extend_to(head)
                } else {
                    Selection::caret(head)
                }
            })
            .collect();
        self.set_selections(all, selections.primary_index())
    }

    fn vertical(&mut self, select: bool, rows: isize) -> Outcome {
        let selections = self.selections.clone();
        let all = selections
            .all()
            .iter()
            .map(|&s| {
                let (head, goal) =
                    movement::vertical(self.buffer, self.layout, s.head, s.goal, rows);
                let anchor = if select { s.anchor } else { head };
                Selection {
                    anchor,
                    head,
                    goal: Some(goal),
                }
            })
            .collect();
        self.set_selections(all, selections.primary_index())
    }

    fn select_lines(&mut self) -> Outcome {
        let selections = self.selections.clone();
        let all = selections
            .all()
            .iter()
            .map(|s| {
                let first = self.buffer.line_of(s.start());
                // A selection of whole lines ends at the next line's start:
                // selecting lines again takes that line too.
                let last = self.buffer.line_of(s.end());
                Selection::new(self.buffer.line_start(first), self.after_line(last))
            })
            .collect();
        self.set_selections(all, selections.primary_index())
    }

    /// The start of the line after `line`, or the text's end after the last.
    fn after_line(&self, line: usize) -> usize {
        if line + 1 < self.buffer.line_count() {
            self.buffer.line_start(line + 1)
        } else {
            self.buffer.len()
        }
    }

    fn select_words(&mut self) -> Outcome {
        let selections = self.selections.clone();
        let all = selections
            .all()
            .iter()
            .map(|&s| self.word_at(s).unwrap_or(s))
            .collect();
        self.set_selections(all, selections.primary_index())
    }

    /// A caret's word as a selection; None for a selection or where there
    /// is no word.
    fn word_at(&self, s: Selection) -> Option<Selection> {
        if !s.is_empty() {
            return None;
        }
        let range = movement::word_range(self.buffer, s.head, self.language.word_chars);
        (!range.is_empty()).then(|| Selection::new(range.start, range.end))
    }

    fn select_next_occurrence(&mut self) -> Outcome {
        let primary = self.selections.primary();
        if primary.is_empty() {
            let Some(word) = self.word_at(primary) else {
                return Outcome::Nothing;
            };
            let mut all = self.selections.all().to_vec();
            all[self.selections.primary_index()] = word;
            return self.set_selections(all, self.selections.primary_index());
        }
        let needle = self.buffer.slice(primary.range());
        let text = self.buffer.text();
        let selected = |start: usize| {
            self.selections
                .all()
                .iter()
                .any(|s| s.start() == start && s.end() == start + needle.len())
        };
        let from = primary.end();
        let after = text[from..].match_indices(&needle).map(|(i, _)| from + i);
        let wrapped = text[..from].match_indices(&needle).map(|(i, _)| i);
        let Some(start) = after.chain(wrapped).find(|&start| !selected(start)) else {
            return Outcome::Nothing;
        };
        let mut selections = self.selections.clone();
        selections.push(Selection::new(start, start + needle.len()));
        self.replace_selections(selections)
    }

    fn select_all_occurrences(&mut self) -> Outcome {
        let primary = self.selections.primary();
        let Some(target) = self
            .word_at(primary)
            .or((!primary.is_empty()).then_some(primary))
        else {
            return Outcome::Nothing;
        };
        let needle = self.buffer.slice(target.range());
        let text = self.buffer.text();
        let all: Vec<Selection> = text
            .match_indices(&needle)
            .map(|(i, _)| Selection::new(i, i + needle.len()))
            .collect();
        let primary = all
            .iter()
            .position(|s| s.start() == target.start())
            .unwrap_or(0);
        self.set_selections(all, primary)
    }

    fn add_caret(&mut self, rows: isize) -> Outcome {
        let primary = self.selections.primary();
        let (offset, goal) =
            movement::vertical(self.buffer, self.layout, primary.head, primary.goal, rows);
        if self.layout.locate(offset).0 == self.layout.locate(primary.head).0 {
            return Outcome::Nothing;
        }
        let mut selections = self.selections.clone();
        selections.push(Selection {
            anchor: offset,
            head: offset,
            goal: Some(goal),
        });
        self.replace_selections(selections)
    }

    fn single_selection(&mut self) -> Outcome {
        if self.selections.len() > 1 {
            let mut selections = self.selections.clone();
            selections.collapse_to_primary();
            return self.replace_selections(selections);
        }
        let primary = self.selections.primary();
        self.set_selections(vec![Selection::caret(primary.head)], 0)
    }

    // Deleting.

    /// Deletes each selection, or for a caret the range `range` gives.
    fn delete_each(
        &mut self,
        kind: EditKind,
        range: impl Fn(&Self, usize) -> Range<usize>,
    ) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let range = if s.is_empty() {
                range(self, s.head)
            } else {
                s.range()
            };
            if range.is_empty() {
                plan.follow(s);
            } else {
                let i = plan.edit(range, "");
                plan.caret(Place::New(i, 0));
            }
        }
        self.commit(plan, kind)
    }

    fn backspace_range(&self, head: usize) -> Range<usize> {
        let buffer = &*self.buffer;
        if head == 0 {
            return 0..0;
        }
        if self.options.auto_close
            && let (Some(before), Some(after)) = (buffer.char_before(head), buffer.char_at(head))
            && self.language.auto_close.contains(&(before, after))
        {
            return head - before.len_utf8()..head + after.len_utf8();
        }
        let start = buffer.line_start(buffer.line_of(head));
        if head > start {
            let before = buffer.slice(start..head);
            if before.bytes().all(|b| b == b' ') {
                // Back to the previous indent stop.
                let remove = (before.len() - 1) % self.tab() + 1;
                return head - remove..head;
            }
        }
        movement::prev_grapheme(buffer, head)..head
    }

    fn delete_lines(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        let line_count = self.buffer.line_count();
        for block in self.blocks(&selections) {
            let (first, last) = (block.first, block.last);
            let i = plan.edit(movement::lines_range(self.buffer, first, last), "");
            for s in block.selections {
                // The caret keeps its column on the line that takes the
                // deleted lines' place.
                let column = self.buffer.point(s.head).column;
                let place = if last + 1 < line_count {
                    let next = last + 1;
                    let at = self.buffer.offset(Point::new(next, column));
                    Place::New(i, at - self.buffer.line_start(next))
                } else if first > 0 {
                    Place::Old(
                        self.buffer.offset(Point::new(first - 1, column)),
                        Bias::Left,
                    )
                } else {
                    Place::New(i, 0)
                };
                plan.caret(place);
            }
        }
        self.commit(plan, EditKind::Other)
    }

    // Lines and indentation.

    /// The runs of lines the selections touch, in order; a selection
    /// ending at a line's start leaves that line out, and touching runs
    /// join.
    fn blocks(&self, selections: &Selections) -> Vec<Block> {
        let mut blocks: Vec<Block> = Vec::new();
        for &s in selections.all() {
            let first = self.buffer.line_of(s.start());
            let mut last = self.buffer.line_of(s.end());
            if !s.is_empty() && last > first && s.end() == self.buffer.line_start(last) {
                last -= 1;
            }
            if let Some(block) = blocks.last_mut()
                && first <= block.last + 1
            {
                block.last = block.last.max(last);
                block.selections.push(s);
                continue;
            }
            blocks.push(Block {
                first,
                last,
                selections: vec![s],
            });
        }
        blocks
    }

    fn tab(&self) -> usize {
        self.options.tab_size.max(1) as usize
    }

    /// One level of indentation.
    fn unit(&self) -> String {
        if self.options.hard_tabs {
            "\t".to_owned()
        } else {
            " ".repeat(self.tab())
        }
    }

    /// `indent` one level out: a tab, or spaces back to the previous stop.
    fn outdented(&self, indent: &str) -> String {
        if let Some(rest) = indent.strip_suffix('\t') {
            return rest.to_owned();
        }
        let spaces = indent.len() - indent.trim_end_matches(' ').len();
        if spaces == 0 {
            return indent.to_owned();
        }
        let remove = (visual_column(indent, self.tab()) - 1) % self.tab() + 1;
        indent[..indent.len() - remove.min(spaces)].to_owned()
    }

    fn newline(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let (start, end) = (s.start(), s.end());
            let mut text = String::from("\n");
            if !self.options.auto_indent {
                let i = plan.edit(start..end, text);
                plan.caret(Place::New(i, 1));
                continue;
            }
            let line_start = self.buffer.line_start(self.buffer.line_of(start));
            let before = self.buffer.slice(line_start..start);
            let indent = leading_whitespace(&before);
            text.push_str(indent);
            let opener = before.trim_end_matches(is_blank).chars().next_back();
            let closer = self.buffer.char_at(end);
            let between = matches!(
                (opener, closer),
                (Some(open), Some(close)) if self.language.brackets.contains(&(open, close))
            );
            if between
                || self
                    .language
                    .indents_after(before.trim_end_matches(is_blank))
            {
                text.push_str(&self.unit());
            }
            let caret = text.len();
            if between {
                // `{|}`: the closing bracket goes on its own line below.
                text.push('\n');
                text.push_str(indent);
            }
            let i = plan.edit(start..end, text);
            plan.caret(Place::New(i, caret));
        }
        self.commit(plan, EditKind::Other)
    }

    fn newline_below(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let line = self.buffer.line_of(s.head);
            let line_text = self.buffer.line_text(line);
            let mut text = String::from("\n");
            if self.options.auto_indent {
                text.push_str(leading_whitespace(&line_text));
                if self
                    .language
                    .indents_after(line_text.trim_end_matches(is_blank))
                {
                    text.push_str(&self.unit());
                }
            }
            let end = self.buffer.line_end(line);
            let i = plan.edit(end..end, text.as_str());
            plan.caret(Place::New(i, text.len()));
        }
        self.commit(plan, EditKind::Other)
    }

    fn newline_above(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let line = self.buffer.line_of(s.head);
            let line_text = self.buffer.line_text(line);
            let mut indent = String::new();
            if self.options.auto_indent {
                indent.push_str(leading_whitespace(&line_text));
                if self
                    .language
                    .outdents(line_text.trim_start_matches(is_blank))
                {
                    indent.push_str(&self.unit());
                }
            }
            let start = self.buffer.line_start(line);
            let i = plan.edit(start..start, format!("{indent}\n"));
            plan.caret(Place::New(i, indent.len()));
        }
        self.commit(plan, EditKind::Other)
    }

    fn indent(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        let one_line = selections
            .all()
            .iter()
            .all(|s| self.buffer.line_of(s.start()) == self.buffer.line_of(s.end()));
        if one_line {
            // To the next tab stop at each caret, replacing what is selected.
            for &s in selections.all() {
                let line_start = self.buffer.line_start(self.buffer.line_of(s.start()));
                let text = if self.options.hard_tabs {
                    "\t".to_owned()
                } else {
                    let column =
                        visual_column(&self.buffer.slice(line_start..s.start()), self.tab());
                    " ".repeat(self.tab() - column % self.tab())
                };
                let i = plan.edit(s.range(), text.as_str());
                plan.caret(Place::New(i, text.len()));
            }
            return self.commit(plan, EditKind::Other);
        }
        let unit = self.unit();
        for block in self.blocks(&selections) {
            for line in block.first..=block.last {
                if self.buffer.line_len(line) > 0 {
                    let start = self.buffer.line_start(line);
                    plan.edit(start..start, unit.as_str());
                }
            }
            for s in block.selections {
                plan.follow(s);
            }
        }
        self.commit(plan, EditKind::Other)
    }

    fn outdent(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for block in self.blocks(&selections) {
            for line in block.first..=block.last {
                let text = self.buffer.line_text(line);
                let indent = leading_whitespace(&text);
                let remove = if indent.starts_with('\t') {
                    1
                } else {
                    let spaces = indent.len() - indent.trim_start_matches(' ').len();
                    spaces.min(self.tab())
                };
                if remove > 0 {
                    let start = self.buffer.line_start(line);
                    plan.edit(start..start + remove, "");
                }
            }
            for s in block.selections {
                plan.follow(s);
            }
        }
        self.commit(plan, EditKind::Other)
    }

    fn toggle_comment(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        if let Some(token) = self.language.line_comment {
            for block in self.blocks(&selections) {
                self.toggle_line_comments(&mut plan, &block, token);
                for s in block.selections {
                    plan.follow(s);
                }
            }
        } else if let Some((open, close)) = self.language.block_comment {
            for &s in selections.all() {
                self.toggle_block_comment(&mut plan, s, open, close);
                plan.follow(s);
            }
        } else {
            return Outcome::Nothing;
        }
        self.commit(plan, EditKind::Other)
    }

    /// Comments `block`'s lines with `token` at their least indentation, or
    /// uncomments them when every non-blank one is commented. Blank lines
    /// stay as they are unless the block has nothing else.
    fn toggle_line_comments(&self, plan: &mut Plan, block: &Block, token: &str) {
        let lines: Vec<(usize, String)> = (block.first..=block.last)
            .map(|line| (self.buffer.line_start(line), self.buffer.line_text(line)))
            .collect();
        let filled: Vec<&(usize, String)> = lines
            .iter()
            .filter(|(_, text)| !text.trim_start_matches(is_blank).is_empty())
            .collect();
        let commented = !filled.is_empty()
            && filled
                .iter()
                .all(|(_, text)| text.trim_start_matches(is_blank).starts_with(token));
        if commented {
            for (start, text) in filled {
                let at = leading_whitespace(text).len();
                let mut len = token.len();
                if text[at + len..].starts_with(' ') {
                    len += 1;
                }
                plan.edit(start + at..start + at + len, "");
            }
            return;
        }
        let targets: Vec<&(usize, String)> = if filled.is_empty() {
            lines.iter().collect()
        } else {
            filled
        };
        let at = targets
            .iter()
            .map(|(_, text)| leading_whitespace(text).len())
            .min()
            .unwrap_or(0);
        for (start, _) in targets {
            plan.edit(start + at..start + at, format!("{token} "));
        }
    }

    /// Wraps the selection (a caret: its line's text) in `open` and `close`,
    /// or unwraps it when it is wrapped.
    fn toggle_block_comment(&self, plan: &mut Plan, s: Selection, open: &str, close: &str) {
        let range = if s.is_empty() {
            let line = self.buffer.line_of(s.head);
            movement::first_non_blank(self.buffer, line)..self.buffer.line_end(line)
        } else {
            s.range()
        };
        let text = self.buffer.slice(range.clone());
        if text.len() >= open.len() + close.len() && text.starts_with(open) && text.ends_with(close)
        {
            let inner = &text[open.len()..text.len() - close.len()];
            let lead = open.len() + usize::from(inner.starts_with(' '));
            let trail = close.len() + usize::from(inner.len() > 1 && inner.ends_with(' '));
            plan.edit(range.start..range.start + lead, "");
            plan.edit(range.end - trail..range.end, "");
        } else {
            plan.edit(range.start..range.start, format!("{open} "));
            plan.edit(range.end..range.end, format!(" {close}"));
        }
    }

    fn move_lines(&mut self, down: bool) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        let line_count = self.buffer.line_count();
        for block in self.blocks(&selections) {
            let (first, last) = (block.first, block.last);
            let movable = if down {
                last + 1 < line_count
            } else {
                first > 0
            };
            if !movable {
                for s in block.selections {
                    plan.follow(s);
                }
                continue;
            }
            let block_start = self.buffer.line_start(first);
            let lines = self.buffer.slice(block_start..self.buffer.line_end(last));
            // The block swaps with its neighbor line; the selections keep
            // their places in the block.
            let (i, shift) = if down {
                let next = self.buffer.line_text(last + 1);
                let range = block_start..self.buffer.line_end(last + 1);
                let shift = next.len() + 1;
                (plan.edit(range, format!("{next}\n{lines}")), shift)
            } else {
                let previous = self.buffer.line_text(first - 1);
                let range = self.buffer.line_start(first - 1)..self.buffer.line_end(last);
                (plan.edit(range, format!("{lines}\n{previous}")), 0)
            };
            for s in block.selections {
                plan.select(
                    Place::New(i, shift + s.anchor - block_start),
                    Place::New(i, shift + s.head - block_start),
                );
            }
        }
        self.commit(plan, EditKind::Other)
    }

    fn duplicate_lines(&mut self, down: bool) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for block in self.blocks(&selections) {
            let block_start = self.buffer.line_start(block.first);
            let block_end = self.buffer.line_end(block.last);
            let lines = self.buffer.slice(block_start..block_end);
            let (i, shift) = if down {
                // The selections move to the copy below.
                (plan.edit(block_end..block_end, format!("\n{lines}")), 1)
            } else {
                (plan.edit(block_start..block_start, format!("{lines}\n")), 0)
            };
            for s in block.selections {
                plan.select(
                    Place::New(i, shift + s.anchor - block_start),
                    Place::New(i, shift + s.head - block_start),
                );
            }
        }
        self.commit(plan, EditKind::Other)
    }

    fn join_lines(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        let line_count = self.buffer.line_count();
        for block in self.blocks(&selections) {
            let last = if block.first == block.last {
                block.first + 1
            } else {
                block.last
            };
            if last >= line_count {
                for s in block.selections {
                    plan.follow(s);
                }
                continue;
            }
            let mut join = 0;
            for line in block.first..last {
                // The line's trailing blanks and the next one's indentation
                // become one space (none next to an empty side).
                let text = self.buffer.line_text(line);
                let next = self.buffer.line_text(line + 1);
                let kept = text.trim_end_matches(is_blank);
                let rest = next.trim_start_matches(is_blank);
                let start = self.buffer.line_start(line) + kept.len();
                let end = self.buffer.line_start(line + 1) + (next.len() - rest.len());
                let space = if kept.is_empty() || rest.is_empty() {
                    ""
                } else {
                    " "
                };
                join = plan.edit(start..end, space);
            }
            for s in block.selections {
                if s.is_empty() && block.first == block.last {
                    plan.caret(Place::New(join, 0));
                } else {
                    plan.follow(s);
                }
            }
        }
        self.commit(plan, EditKind::Other)
    }

    fn transpose(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let head = s.head;
            let line = self.buffer.line_of(head);
            let (start, end) = (self.buffer.line_start(line), self.buffer.line_end(line));
            let pair = if !s.is_empty() || head == start {
                None
            } else if head == end {
                // At the line's end: the two graphemes before the caret.
                let middle = movement::prev_grapheme(self.buffer, head);
                (middle > start)
                    .then(|| (movement::prev_grapheme(self.buffer, middle), middle, head))
            } else {
                Some((
                    movement::prev_grapheme(self.buffer, head),
                    head,
                    movement::next_grapheme(self.buffer, head),
                ))
            };
            let Some((a, b, c)) = pair else {
                plan.follow(s);
                continue;
            };
            let swapped = self.buffer.slice(b..c) + &self.buffer.slice(a..b);
            let len = swapped.len();
            let i = plan.edit(a..c, swapped);
            plan.caret(Place::New(i, len));
        }
        self.commit(plan, EditKind::Other)
    }

    fn history(&mut self, undo: bool) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let restored = if undo {
            self.buffer.undo()
        } else {
            self.buffer.redo()
        };
        match restored {
            Some((changes, mut selections)) => {
                selections.clamp(self.buffer.len());
                *self.selections = selections;
                Outcome::Edited(changes)
            }
            None => Outcome::Nothing,
        }
    }

    // Typing.

    /// What typing `c` does at `s` beyond replacing it: stepping over a
    /// closing char, auto-closing a pair, outdenting a closing bracket.
    /// Whether it planned something.
    fn typed_char(&self, plan: &mut Plan, s: Selection, c: char) -> bool {
        let buffer = &*self.buffer;
        let pairs = self.language.auto_close;
        if self.options.auto_close {
            if s.is_empty()
                && buffer.char_at(s.head) == Some(c)
                && pairs.iter().any(|&(_, close)| close == c)
            {
                plan.caret(Place::Old(s.head + c.len_utf8(), Bias::Right));
                return true;
            }
            if let Some(&(open, close)) = pairs.iter().find(|&&(open, _)| open == c) {
                if !s.is_empty() {
                    let inner = buffer.slice(s.range());
                    let len = inner.len();
                    let i = plan.edit(s.range(), format!("{open}{inner}{close}"));
                    plan.select_inside(i, open.len_utf8(), len, s.is_reversed());
                    return true;
                }
                if self.language.should_auto_close(
                    c,
                    buffer.char_before(s.head),
                    buffer.char_at(s.head),
                ) {
                    let i = plan.edit(s.head..s.head, format!("{open}{close}"));
                    plan.caret(Place::New(i, open.len_utf8()));
                    return true;
                }
            }
        }
        if self.options.auto_indent
            && s.is_empty()
            && let Some(indent) = self.closer_indent(s.head, c)
        {
            let start = buffer.line_start(buffer.line_of(s.head));
            let text = format!("{indent}{c}");
            let len = text.len();
            let i = plan.edit(start..s.head, text);
            plan.caret(Place::New(i, len));
            return true;
        }
        false
    }

    /// The indentation closing bracket `c` typed at `head` gets, when only
    /// blanks are before it on its line: its opening bracket's line's (one
    /// level out when there is none). None when it stays.
    fn closer_indent(&self, head: usize, c: char) -> Option<String> {
        let &(open, _) = self
            .language
            .brackets
            .iter()
            .find(|&&(_, close)| close == c)?;
        let buffer = &*self.buffer;
        let line_start = buffer.line_start(buffer.line_of(head));
        let before = buffer.slice(line_start..head);
        if before.is_empty() || !before.chars().all(is_blank) {
            return None;
        }
        let mut depth = 0usize;
        let mut at = line_start;
        let mut found = None;
        for ch in buffer.chars_before(line_start).take(100_000) {
            at -= ch.len_utf8();
            if ch == c {
                depth += 1;
            } else if ch == open {
                if depth == 0 {
                    found = Some(at);
                    break;
                }
                depth -= 1;
            }
        }
        let indent = match found {
            Some(at) => leading_whitespace(&buffer.line_text(buffer.line_of(at))).to_owned(),
            None => self.outdented(&before),
        };
        (indent != before).then_some(indent)
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{Points, px};

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

    /// An editor's state written as text: `ˇ` a caret, `«…»` a selection
    /// (its head at `»`); the last one written is primary.
    struct Test {
        buffer: Buffer,
        selections: Selections,
        language: &'static LanguageConfig,
        options: EditOptions,
    }

    impl Test {
        fn plain(marked: &str) -> Test {
            Test::with(&PLAIN_TEXT, marked)
        }

        fn rust(marked: &str) -> Test {
            Test::with(language::language("rust"), marked)
        }

        fn with(language: &'static LanguageConfig, marked: &str) -> Test {
            let mut text = String::new();
            let mut all = Vec::new();
            let mut anchor = 0;
            for c in marked.chars() {
                match c {
                    'ˇ' => all.push(Selection::caret(text.len())),
                    '«' => anchor = text.len(),
                    '»' => all.push(Selection::new(anchor, text.len())),
                    c => text.push(c),
                }
            }
            let primary = all.len().saturating_sub(1);
            Test {
                buffer: Buffer::new(&text),
                selections: Selections::new(all, primary),
                language,
                options: EditOptions {
                    tab_size: 4,
                    ..EditOptions::default()
                },
            }
        }

        fn edit<R>(&mut self, f: impl FnOnce(&mut Editing<'_>) -> R) -> R {
            let rows = Rows::new(&self.buffer);
            let mut cx = Editing {
                buffer: &mut self.buffer,
                selections: &mut self.selections,
                language: self.language,
                options: &self.options,
                layout: &rows,
                page_rows: 3,
            };
            f(&mut cx)
        }

        fn run(&mut self, command: Command) -> Outcome {
            self.edit(|cx| cx.run(command))
        }

        fn insert(&mut self, text: &str) -> Outcome {
            self.edit(|cx| cx.insert(text))
        }

        fn state(&self) -> String {
            let mut marks: Vec<(usize, u8, char)> = Vec::new();
            for s in self.selections.all() {
                if s.is_empty() {
                    marks.push((s.head, 1, 'ˇ'));
                } else {
                    marks.push((s.start(), 2, '«'));
                    marks.push((s.end(), 0, '»'));
                }
            }
            marks.sort();
            let text = self.buffer.text();
            let mut out = String::new();
            let mut at = 0;
            for (offset, _, mark) in marks {
                out.push_str(&text[at..offset]);
                out.push(mark);
                at = offset;
            }
            out.push_str(&text[at..]);
            out
        }

        fn assert(&self, marked: &str) {
            assert_eq!(self.state(), marked);
        }
    }

    fn edited(outcome: &Outcome) -> bool {
        matches!(outcome, Outcome::Edited(_))
    }

    #[test]
    fn typing_at_every_caret() {
        let mut t = Test::plain("aˇ\nbˇ\ncˇ");
        t.insert("x");
        t.assert("axˇ\nbxˇ\ncxˇ");
        t.insert("日本");
        t.assert("ax日本ˇ\nbx日本ˇ\ncx日本ˇ");

        let mut t = Test::plain("«ab»\n«cd»");
        t.insert("é");
        t.assert("éˇ\néˇ");

        let mut t = Test::plain("ˇ");
        t.insert("a\r\nb");
        t.assert("a\nbˇ");
    }

    #[test]
    fn auto_close_and_type_over() {
        let mut t = Test::rust("fn fˇ");
        t.insert("(");
        t.assert("fn f(ˇ)");
        t.insert(")");
        t.assert("fn f()ˇ");

        let mut t = Test::rust("let s = ˇ");
        t.insert("\"");
        t.assert("let s = \"ˇ\"");
        t.insert("a");
        t.insert("\"");
        t.assert("let s = \"a\"ˇ");

        // Not before a word.
        let mut t = Test::rust("ˇfoo");
        t.insert("(");
        t.assert("(ˇfoo");

        // A selection is wrapped and stays selected.
        let mut t = Test::rust("«foo» «日本»");
        t.insert("[");
        t.assert("[«foo»] [«日本»]");

        let mut t = Test::rust("aˇ\nbˇ");
        t.insert("{");
        t.assert("a{ˇ}\nb{ˇ}");
        t.run(Command::Backspace);
        t.assert("aˇ\nbˇ");

        let mut t = Test::rust("fn fˇ");
        t.options.auto_close = false;
        t.insert("(");
        t.assert("fn f(ˇ");
    }

    #[test]
    fn newline_keeps_and_adds_indentation() {
        let mut t = Test::rust("fn main() {ˇ}");
        t.run(Command::Newline);
        t.assert("fn main() {\n    ˇ\n}");

        let mut t = Test::rust("    let a = 1;ˇ");
        t.insert("\n");
        t.assert("    let a = 1;\n    ˇ");

        let mut t = Test::rust("\tif x {ˇ}");
        t.options.hard_tabs = true;
        t.run(Command::Newline);
        t.assert("\tif x {\n\t\tˇ\n\t}");

        let mut t = Test::plain("  aˇ");
        t.run(Command::Newline);
        t.assert("  a\n  ˇ");

        let mut t = Test::plain("  aˇ");
        t.options.auto_indent = false;
        t.run(Command::Newline);
        t.assert("  a\nˇ");

        // In the indentation, only what is before the caret carries over.
        let mut t = Test::plain("  ˇ  a");
        t.run(Command::Newline);
        t.assert("  \n  ˇ  a");
    }

    #[test]
    fn a_closing_bracket_outdents_a_blank_line() {
        let mut t = Test::rust("fn f() {\n    if x {\n        ˇ");
        t.insert("}");
        t.assert("fn f() {\n    if x {\n    }ˇ");

        // Without the opening bracket: one level out.
        let mut t = Test::rust("      ˇ");
        t.insert(")");
        t.assert("    )ˇ");
    }

    #[test]
    fn backspace_deletes_indentation_and_graphemes() {
        let mut t = Test::plain("        ˇx");
        t.run(Command::Backspace);
        t.assert("    ˇx");

        let mut t = Test::plain("      ˇ");
        t.run(Command::Backspace);
        t.assert("    ˇ");

        let mut t = Test::plain("  aˇ");
        t.run(Command::Backspace);
        t.assert("  ˇ");

        let mut t = Test::plain("a👍🏽ˇ");
        t.run(Command::Backspace);
        t.assert("aˇ");

        let mut t = Test::plain("a\nˇb");
        t.run(Command::Backspace);
        t.assert("aˇb");

        let mut t = Test::plain("ˇ");
        assert_eq!(t.run(Command::Backspace), Outcome::Nothing);
        assert_eq!(t.run(Command::Delete), Outcome::Nothing);

        // Carets whose deletions meet.
        let mut t = Test::plain("abˇcˇd");
        t.run(Command::Backspace);
        t.assert("aˇd");
    }

    #[test]
    fn deleting_words_and_line_parts() {
        let mut t = Test::plain("foo barˇ");
        t.run(Command::DeleteWordLeft);
        t.assert("foo ˇ");

        let mut t = Test::plain("ˇfoo bar");
        t.run(Command::DeleteWordRight);
        t.assert("ˇ bar");

        let mut t = Test::plain("a\nbcˇd");
        t.run(Command::DeleteToLineStart);
        t.assert("a\nˇd");
        t.run(Command::DeleteToLineStart);
        t.assert("aˇd");

        let mut t = Test::plain("aˇb\nc");
        t.run(Command::DeleteToLineEnd);
        t.assert("aˇ\nc");
        t.run(Command::DeleteToLineEnd);
        t.assert("aˇc");
    }

    #[test]
    fn toggle_comment() {
        let mut t = Test::rust("    «a\n      b»");
        t.run(Command::ToggleComment);
        assert_eq!(t.buffer.text(), "    // a\n    //   b");
        t.run(Command::ToggleComment);
        assert_eq!(t.buffer.text(), "    a\n      b");

        let mut t = Test::rust("«a\n\nb»");
        t.run(Command::ToggleComment);
        assert_eq!(t.buffer.text(), "// a\n\n// b");

        // Partly commented lines get commented.
        let mut t = Test::rust("«// a\nb»");
        t.run(Command::ToggleComment);
        assert_eq!(t.buffer.text(), "// // a\n// b");

        let mut t = Test::rust("aˇ");
        t.run(Command::ToggleComment);
        t.assert("// aˇ");

        // A selection ending at a line's start leaves that line alone.
        let mut t = Test::rust("«a\n»b");
        t.run(Command::ToggleComment);
        assert_eq!(t.buffer.text(), "// a\nb");

        let mut t = Test::plain("aˇ");
        assert_eq!(t.run(Command::ToggleComment), Outcome::Nothing);
    }

    #[test]
    fn move_lines() {
        let mut t = Test::plain("aˇ\nb\nc");
        t.run(Command::MoveLinesDown);
        t.assert("b\naˇ\nc");
        t.run(Command::MoveLinesDown);
        t.assert("b\nc\naˇ");
        assert_eq!(t.run(Command::MoveLinesDown), Outcome::Nothing);
        t.run(Command::MoveLinesUp);
        t.assert("b\naˇ\nc");

        let mut t = Test::plain("«a\nb»\nc");
        t.run(Command::MoveLinesDown);
        t.assert("c\n«a\nb»");
        t.run(Command::MoveLinesUp);
        t.assert("«a\nb»\nc");

        // Two carets on separate lines move each their line.
        let mut t = Test::plain("aˇ\nb\ncˇ\nd");
        t.run(Command::MoveLinesDown);
        t.assert("b\naˇ\nd\ncˇ");

        let mut t = Test::plain("ˇ");
        assert_eq!(t.run(Command::MoveLinesUp), Outcome::Nothing);
    }

    #[test]
    fn duplicate_lines() {
        let mut t = Test::plain("aˇb\nc");
        t.run(Command::DuplicateLinesDown);
        t.assert("ab\naˇb\nc");

        let mut t = Test::plain("aˇb\nc");
        t.run(Command::DuplicateLinesUp);
        t.assert("aˇb\nab\nc");

        let mut t = Test::plain("«a\nb»");
        t.run(Command::DuplicateLinesDown);
        t.assert("a\nb\n«a\nb»");
    }

    #[test]
    fn delete_join_and_transpose() {
        let mut t = Test::plain("a\nbˇc\nd");
        t.run(Command::DeleteLine);
        t.assert("a\ndˇ");

        let mut t = Test::plain("ab\ncˇd");
        t.run(Command::DeleteLine);
        t.assert("aˇb");

        let mut t = Test::plain("ˇ");
        assert_eq!(t.run(Command::DeleteLine), Outcome::Nothing);

        let mut t = Test::plain("aˇ  \n    b");
        t.run(Command::JoinLines);
        t.assert("aˇ b");

        let mut t = Test::plain("abˇc");
        t.run(Command::TransposeChars);
        t.assert("acbˇ");

        let mut t = Test::plain("x\n日本ˇ");
        t.run(Command::TransposeChars);
        t.assert("x\n本日ˇ");
    }

    #[test]
    fn indent_and_outdent() {
        let mut t = Test::plain("ˇa");
        t.run(Command::Indent);
        t.assert("    ˇa");

        let mut t = Test::plain("  ˇa");
        t.run(Command::Indent);
        t.assert("    ˇa");

        let mut t = Test::plain("日ˇ");
        t.run(Command::Indent);
        t.assert("日   ˇ");

        let mut t = Test::plain("«a\n\nb»");
        t.run(Command::Indent);
        assert_eq!(t.buffer.text(), "    a\n\n    b");
        t.run(Command::Outdent);
        assert_eq!(t.buffer.text(), "a\n\nb");

        let mut t = Test::plain("\t  ˇa");
        t.run(Command::Outdent);
        t.assert("  ˇa");
    }

    #[test]
    fn new_lines_below_and_above() {
        let mut t = Test::plain("    aˇb");
        t.run(Command::NewlineBelow);
        t.assert("    ab\n    ˇ");

        let mut t = Test::plain("    aˇb");
        t.run(Command::NewlineAbove);
        t.assert("    ˇ\n    ab");

        let mut t = Test::rust("fn f() {ˇ");
        t.run(Command::NewlineBelow);
        t.assert("fn f() {\n    ˇ");
    }

    #[test]
    fn select_occurrences() {
        let mut t = Test::plain("ˇfoo bar foo foo");
        t.run(Command::SelectNextOccurrence);
        t.assert("«foo» bar foo foo");
        t.run(Command::SelectNextOccurrence);
        t.assert("«foo» bar «foo» foo");
        t.run(Command::SelectNextOccurrence);
        t.run(Command::SelectNextOccurrence);
        t.assert("«foo» bar «foo» «foo»");
        assert_eq!(t.run(Command::SelectNextOccurrence), Outcome::Nothing);
        t.insert("x");
        t.assert("xˇ bar xˇ xˇ");

        let mut t = Test::plain("foo bar fˇoo");
        t.run(Command::SelectAllOccurrences);
        t.assert("«foo» bar «foo»");
        assert_eq!(t.selections.primary().start(), 8);
    }

    #[test]
    fn select_lines_and_words() {
        let mut t = Test::plain("aˇb\ncd\nef");
        t.run(Command::SelectLine);
        t.assert("«ab\n»cd\nef");
        t.run(Command::SelectLine);
        t.assert("«ab\ncd\n»ef");
        t.run(Command::SelectLine);
        t.assert("«ab\ncd\nef»");

        let mut t = Test::plain("foo bˇar");
        t.run(Command::SelectWord);
        t.assert("foo «bar»");
    }

    #[test]
    fn copy_cut_and_paste_whole_lines() {
        let mut t = Test::plain("aˇb\ncd");
        assert_eq!(t.edit(|cx| cx.copy()), ("ab\n".to_owned(), true));
        let (text, line_wise, outcome) = t.edit(|cx| cx.cut());
        assert_eq!((text.as_str(), line_wise), ("ab\n", true));
        assert!(edited(&outcome));
        t.assert("cˇd");
        t.edit(|cx| cx.paste("ab\n", true));
        t.assert("ab\ncˇd");

        // The last line, without a line break.
        let mut t = Test::plain("a\nbˇ");
        let (text, _, _) = t.edit(|cx| cx.cut());
        assert_eq!(text, "b\n");
        t.assert("aˇ");

        let mut t = Test::plain("«ab» «cd»");
        assert_eq!(t.edit(|cx| cx.copy()), ("ab\ncd".to_owned(), false));
        t.edit(|cx| cx.cut());
        t.assert("ˇ ˇ");

        // One line per caret when the counts match.
        let mut t = Test::plain("ˇ\nˇ");
        t.edit(|cx| cx.paste("x\ny", false));
        t.assert("xˇ\nyˇ");

        let mut t = Test::plain("ˇ\nˇ");
        t.edit(|cx| cx.paste("x\ny\nz", false));
        t.assert("x\ny\nzˇ\nx\ny\nzˇ");

        let mut t = Test::plain("aˇ\nbˇ");
        t.edit(|cx| cx.paste("1\n2\n", true));
        t.assert("1\naˇ\n2\nbˇ");
    }

    #[test]
    fn undo_and_redo_restore_selections() {
        let mut t = Test::plain("aˇ\nbˇ");
        t.insert("x");
        t.insert("y");
        t.assert("axyˇ\nbxyˇ");
        assert!(edited(&t.run(Command::Undo)));
        t.assert("aˇ\nbˇ");
        assert!(edited(&t.run(Command::Redo)));
        t.assert("axyˇ\nbxyˇ");
        t.run(Command::Undo);
        assert_eq!(t.run(Command::Undo), Outcome::Nothing);
    }

    #[test]
    fn read_only_moves_but_never_edits() {
        let mut t = Test::rust("aˇb\nc");
        t.options.read_only = true;
        assert_eq!(t.insert("x"), Outcome::Nothing);
        assert_eq!(t.run(Command::Backspace), Outcome::Nothing);
        assert_eq!(t.run(Command::DeleteLine), Outcome::Nothing);
        assert_eq!(t.run(Command::ToggleComment), Outcome::Nothing);
        assert_eq!(t.edit(|cx| cx.paste("x", false)), Outcome::Nothing);
        let (text, line_wise, outcome) = t.edit(|cx| cx.cut());
        assert_eq!(
            (text.as_str(), line_wise, outcome),
            ("ab\n", true, Outcome::Nothing)
        );
        assert_eq!(t.buffer.text(), "ab\nc");
        assert_eq!(t.run(Command::Right { select: false }), Outcome::Moved);
        t.assert("abˇ\nc");
    }

    #[test]
    fn moves_and_goals() {
        let mut t = Test::plain("abcdˇ\nx\nabcd");
        t.run(Command::Down { select: false });
        t.assert("abcd\nxˇ\nabcd");
        t.run(Command::Down { select: false });
        t.assert("abcd\nx\nabcdˇ");
        t.run(Command::Left { select: false });
        assert!(t.selections.all().iter().all(|s| s.goal.is_none()));

        let mut t = Test::plain("a«bc»d");
        t.run(Command::Left { select: false });
        t.assert("aˇbcd");

        let mut t = Test::plain("aˇb");
        t.run(Command::Right { select: true });
        t.assert("a«b»");
        t.run(Command::DocumentStart { select: false });
        t.assert("ˇab");

        let mut t = Test::plain("aˇb\ncd");
        t.run(Command::AddCaretBelow);
        t.assert("aˇb\ncˇd");
        assert_eq!(t.run(Command::AddCaretBelow), Outcome::Nothing);
        t.run(Command::SingleSelection);
        t.assert("ab\ncˇd");

        let mut t = Test::rust("ˇ(a)");
        t.run(Command::MatchingBracket);
        t.assert("(aˇ)");
        t.run(Command::MatchingBracket);
        t.assert("ˇ(a)");
    }

    #[test]
    fn replace_keeps_selections_in_place() {
        let mut t = Test::plain("aˇbc");
        t.edit(|cx| cx.replace(vec![(0..1, "xyz".to_owned())]));
        t.assert("xyzˇbc");
        t.edit(|cx| cx.replace(vec![(3..5, String::new())]));
        t.assert("xyzˇ");
    }

    #[test]
    fn select_previous_occurrence() {
        let mut t = Test::plain("foo bar foo fˇoo");
        t.run(Command::SelectPreviousOccurrence);
        t.assert("foo bar foo «foo»");
        t.run(Command::SelectPreviousOccurrence);
        t.assert("foo bar «foo» «foo»");
        t.run(Command::SelectPreviousOccurrence);
        t.assert("«foo» bar «foo» «foo»");
        assert_eq!(t.selections.primary().start(), 0);
        assert_eq!(t.run(Command::SelectPreviousOccurrence), Outcome::Nothing);

        // Wraps around to the end.
        let mut t = Test::plain("«ab» x ab");
        t.run(Command::SelectPreviousOccurrence);
        t.assert("«ab» x «ab»");
    }

    #[test]
    fn subword_and_paragraph_moves() {
        let mut t = Test::plain("ˇfooBar_baz");
        t.run(Command::SubwordRight { select: false });
        t.assert("fooˇBar_baz");
        t.run(Command::SubwordRight { select: true });
        t.assert("foo«Bar»_baz");
        t.run(Command::SubwordLeft { select: false });
        t.assert("fooˇBar_baz");

        let mut t = Test::plain("aˇ\nb\n\nc");
        t.run(Command::ParagraphDown { select: false });
        t.assert("a\nb\nˇ\nc");
        t.run(Command::ParagraphDown { select: true });
        t.assert("a\nb\n«\nc»");
        t.run(Command::ParagraphUp { select: false });
        t.assert("a\nb\nˇ\nc");
    }

    #[test]
    fn sort_lines() {
        let mut t = Test::plain("x\n«c\na\nb»\nw");
        t.run(Command::SortLines { descending: false });
        t.assert("x\n«a\nb\nc»\nw");
        t.run(Command::SortLines { descending: true });
        t.assert("x\n«c\nb\na»\nw");

        // A caret alone sorts every line.
        let mut t = Test::plain("b\naˇ\nc");
        t.run(Command::SortLines { descending: false });
        assert_eq!(t.buffer.text(), "a\nb\nc");

        // Sorted already: nothing to do; a selection on one line neither.
        let mut t = Test::plain("«a\nb»");
        assert_eq!(
            t.run(Command::SortLines { descending: false }),
            Outcome::Nothing
        );
        let mut t = Test::plain("«b» a\nc");
        assert_eq!(
            t.run(Command::SortLines { descending: false }),
            Outcome::Nothing
        );

        // A selection ending at a line's start leaves that line out; carets
        // stay on character boundaries.
        let mut t = Test::plain("«日本\nab\n»0");
        t.run(Command::SortLines { descending: false });
        assert_eq!(t.buffer.text(), "ab\n日本\n0");
        let mut t = Test::plain("日ˇ本\nbˇ");
        t.run(Command::SortLines { descending: false });
        t.assert("b\nˇ日本ˇ");
    }

    #[test]
    fn change_case() {
        let mut t = Test::plain("«hello world» foo");
        t.run(Command::ChangeCase(Case::Upper));
        t.assert("«HELLO WORLD» foo");
        t.run(Command::ChangeCase(Case::Title));
        t.assert("«Hello World» foo");
        t.run(Command::ChangeCase(Case::Lower));
        t.assert("«hello world» foo");

        // A caret changes its word and stays in place.
        let mut t = Test::plain("one twˇo");
        t.run(Command::ChangeCase(Case::Upper));
        t.assert("one TWˇO");

        // Lengths may change: the selection covers the new text.
        let mut t = Test::plain("«straße»");
        t.run(Command::ChangeCase(Case::Upper));
        t.assert("«STRASSE»");

        let mut t = Test::plain("«don't stop»");
        t.run(Command::ChangeCase(Case::Title));
        t.assert("«Don't Stop»");

        let mut t = Test::plain("«ABC»");
        assert_eq!(t.run(Command::ChangeCase(Case::Upper)), Outcome::Nothing);
    }

    #[test]
    fn trim_trailing_whitespace() {
        let mut t = Test::plain("a  \n\t\nb ˇ \nc");
        t.run(Command::TrimTrailingWhitespace);
        t.assert("a\n\nbˇ\nc");
        assert_eq!(t.run(Command::TrimTrailingWhitespace), Outcome::Nothing);
    }

    #[test]
    fn toggle_block_comment() {
        let mut t = Test::rust("    aˇ");
        t.run(Command::ToggleBlockComment);
        t.assert("    /* a */ˇ");
        t.run(Command::ToggleBlockComment);
        t.assert("    aˇ");

        let mut t = Test::rust("x «a + b» y");
        t.run(Command::ToggleBlockComment);
        assert_eq!(t.buffer.text(), "x /* a + b */ y");

        let mut t = Test::plain("aˇ");
        assert_eq!(t.run(Command::ToggleBlockComment), Outcome::Nothing);
    }

    #[test]
    fn split_selection_into_lines() {
        let mut t = Test::plain("a«bc\n\nde»f\nˇg");
        t.run(Command::SplitSelectionIntoLines);
        t.assert("a«bc»\nˇ\n«de»f\nˇg");
        assert_eq!(t.selections.primary().head, 9);

        // A selection ending at a line's start leaves that line out.
        let mut t = Test::plain("«ab\ncd\n»ef");
        t.run(Command::SplitSelectionIntoLines);
        t.assert("«ab»\n«cd»\nef");
        assert_eq!(t.selections.primary().start(), 3);

        let mut t = Test::plain("a«b»c");
        assert_eq!(t.run(Command::SplitSelectionIntoLines), Outcome::Nothing);
    }
}
