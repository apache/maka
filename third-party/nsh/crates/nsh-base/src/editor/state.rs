//! What an editor holds between frames, outside the reactive graph: the
//! buffer, the selections, the display map, the highlighter and the marks.
//! The view reads it in bindings that subscribe to the revisions the
//! component bumps ([`super::Revisions`]), so a change reaches only what
//! depends on it.

use std::{ops::Range, rc::Rc};

use nsh_core::geometry::{Bounds, Point as Pt, Points, Size, px};

use super::{
    EditorDecoration, EditorDiagnostic, EditorDiagnosticSeverity, EditorDiagnosticTag,
    EditorPosition, EditorSearch, EditorSearchResult, EditorSelection, app_highlight,
    buffer::{Buffer, Change},
    commands::{EditOptions, Editing},
    diagnostics::{self, Mark},
    display::DisplayMap,
    fold::{self, FoldRange},
    fold_set,
    highlight::{Highlighter, LineEdit, Syntax},
    language::LanguageConfig,
    movement, search,
    types::{RowLayout, Selection, Selections},
};
use crate::syntax::Token;

/// How many matches a search counts at most.
pub(crate) const MATCH_LIMIT: usize = 10_000;

/// The font the text is drawn and measured in.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Font {
    pub(crate) family: nsh_core::element::SharedString,
    pub(crate) size: Points,
    pub(crate) line_height: Points,
}

impl Font {
    /// The CSS `font` shorthand `measure_text` takes.
    pub(crate) fn css(&self) -> String {
        let family = self.family.as_str();
        // Generic families stay bare; named ones are quoted.
        let generic = matches!(
            family,
            "monospace" | "sans-serif" | "serif" | "system-ui" | "ui-monospace"
        );
        if generic {
            format!("{}px {}", self.size.0, family)
        } else {
            format!("{}px \"{}\"", self.size.0, family.replace('"', ""))
        }
    }
}

/// A span of a row's text and what styles it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Span {
    pub(crate) text: String,
    pub(crate) token: Option<Token>,
    /// The decorations over it (indexes into the editor's decorations).
    pub(crate) decorations: Vec<usize>,
    /// The diagnostics over it: their tags (faded, struck through) and
    /// the most serious one's underline.
    pub(crate) tags: SpanTags,
}

/// The diagnostics over a span: how its text is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct SpanTags {
    /// The most serious diagnostic's severity: a wavy underline of its
    /// color (a tagged hint shows in its text alone, as language clients
    /// draw it).
    pub(crate) severity: Option<EditorDiagnosticSeverity>,
    /// Under an `unnecessary` diagnostic: faded.
    pub(crate) unnecessary: bool,
    /// Under a `deprecated` diagnostic: struck through.
    pub(crate) deprecated: bool,
}

impl SpanTags {
    /// The tags of `diagnostic`.
    fn of(diagnostic: &EditorDiagnostic) -> SpanTags {
        let quiet =
            diagnostic.severity == EditorDiagnosticSeverity::Hint && !diagnostic.tags.is_empty();
        SpanTags {
            severity: (!quiet).then_some(diagnostic.severity),
            unnecessary: diagnostic.tags.contains(&EditorDiagnosticTag::Unnecessary),
            deprecated: diagnostic.tags.contains(&EditorDiagnosticTag::Deprecated),
        }
    }

    /// Nothing to draw.
    pub(crate) fn is_empty(self) -> bool {
        self.severity.is_none() && !self.unnecessary && !self.deprecated
    }

    /// Both spans' tags.
    fn union(self, other: SpanTags) -> SpanTags {
        let severity = match (self.severity, other.severity) {
            (Some(a), Some(b)) => Some(if diagnostics::rank(b) < diagnostics::rank(a) {
                b
            } else {
                a
            }),
            (a, b) => a.or(b),
        };
        SpanTags {
            severity,
            unnecessary: self.unnecessary || other.unnecessary,
            deprecated: self.deprecated || other.deprecated,
        }
    }
}

/// What one display row shows: its spans, whether a fold ends it (the
/// placeholder after the text) and its line's number when it starts the
/// line.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct RowContent {
    pub(crate) spans: Vec<Span>,
    pub(crate) folded: bool,
    /// The decorations whose line styles cover the row's line.
    pub(crate) line_decorations: Vec<usize>,
}

/// What the gutter shows for a display row.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct GutterRow {
    /// The line number to show (from 1), on a row that starts its line.
    pub(crate) number: Option<usize>,
    /// The line has a caret.
    pub(crate) active: bool,
    /// A fold can start on the line: `Some(folded)`.
    pub(crate) fold: Option<bool>,
    /// The most serious diagnostic on the line.
    pub(crate) severity: Option<EditorDiagnosticSeverity>,
}

/// A rectangle to draw, in the coordinates of the rows' box.
pub(crate) type Rect = Bounds<Points>;

/// The editor's state.
pub(crate) struct State {
    pub(crate) buffer: Buffer,
    pub(crate) selections: Selections,
    pub(crate) display: DisplayMap,
    pub(crate) highlighter: Option<Highlighter>,
    /// What highlights the language: the built-in highlighter, or the
    /// app's (`register_highlighter`).
    pub(crate) syntax: Syntax,
    pub(crate) language: &'static LanguageConfig,
    pub(crate) options: EditOptions,
    pub(crate) font: Font,
    pub(crate) diagnostics: Vec<Mark<EditorDiagnostic>>,
    /// The longest diagnostic's bytes: a row looks for the diagnostics
    /// over it among those starting this far before it.
    tag_reach: usize,
    /// The decorations' ranges, each carrying its index in `decoration_items`.
    pub(crate) decorations: Vec<Mark<usize>>,
    /// The decorations as the app gave them (classes and styles by index).
    pub(crate) decoration_items: Vec<EditorDecoration>,
    /// The longest decoration's bytes: a row looks for the decorations
    /// over it among those starting this far before it, not among all.
    decoration_reach: usize,
    /// The built-in highlighting on (`highlighting`).
    pub(crate) highlighting: bool,
    pub(crate) search: Option<EditorSearch>,
    pub(crate) matches: Vec<Range<usize>>,
    pub(crate) search_error: Option<String>,
    /// Where folds can start, found again after edits (lazily).
    fold_candidates: Option<Vec<FoldRange>>,
    /// Folding on.
    pub(crate) folding: bool,
    /// The app's `foldRanges` (normalized, carried through edits); None:
    /// folds by indentation.
    app_folds: Option<Vec<FoldRange>>,
    /// Every folded range, nested ones included (sorted, normalized).
    folded: Vec<FoldRange>,
    /// The folded ranges last reported (`onFoldChange`).
    pub(crate) reported_folds: Vec<FoldRange>,
    /// What an input method is composing at the primary caret.
    pub(crate) composition: Option<String>,
    /// The text last reported to the app (`onChange`) or set by it, and
    /// the buffer's version then: an unchanged version is an unchanged
    /// text, with no need to make or compare the whole text.
    pub(crate) reported: Option<(u64, nsh_core::element::SharedString)>,
    /// The selections last reported (`onSelectionChange`).
    pub(crate) reported_selections: Vec<EditorSelection>,
    /// What a search in the selection searches, carried through edits
    /// (`select::set_search`).
    pub(crate) search_scope: Option<Vec<Mark<()>>>,
}

impl State {
    pub(crate) fn new(
        text: &str,
        language: &'static LanguageConfig,
        options: EditOptions,
        font: Font,
        measure: Rc<dyn Fn(&str) -> Points>,
    ) -> State {
        let buffer = Buffer::new(text);
        let mut display = DisplayMap::new(measure, options.tab_size);
        display.rebuild(&buffer);
        State {
            buffer,
            selections: Selections::default(),
            display,
            // Made once the syntaxes are loaded (`Ed::load_syntaxes`), never
            // here: loading them blocks for tens of milliseconds.
            highlighter: if Highlighter::ready() {
                Highlighter::new(language.syntax_hint)
            } else {
                None
            },
            syntax: Syntax::builtin(language.syntax_hint),
            language,
            options,
            font,
            diagnostics: Vec::new(),
            tag_reach: 0,
            decorations: Vec::new(),
            decoration_items: Vec::new(),
            decoration_reach: 0,
            highlighting: true,
            search: None,
            matches: Vec::new(),
            search_error: None,
            fold_candidates: None,
            folding: true,
            app_folds: None,
            folded: Vec::new(),
            reported_folds: Vec::new(),
            composition: None,
            reported: None,
            reported_selections: Vec::new(),
            search_scope: None,
        }
    }

    pub(crate) fn line_height(&self) -> Points {
        self.font.line_height
    }

    /// Runs `f` on an [`Editing`] of the state with `page_rows` rows a page.
    pub(crate) fn editing<R>(
        &mut self,
        page_rows: usize,
        f: impl FnOnce(&mut Editing<'_>) -> R,
    ) -> R {
        let before = self.buffer.snapshot();
        let layout = self.display.layout(&before);
        let mut editing = Editing {
            buffer: &mut self.buffer,
            selections: &mut self.selections,
            language: self.language,
            options: &self.options,
            layout: &layout,
            page_rows,
        };
        f(&mut editing)
    }

    /// Brings what follows the text up to date after `changes` (the
    /// buffer's last change list): the layout, the highlighting, the marks
    /// and the matches.
    pub(crate) fn changed(&mut self, changes: &[Change]) {
        if changes.is_empty() {
            return;
        }
        match self.buffer.last_line_span() {
            Some(span) => {
                self.display.edited(&self.buffer, span);
                if let Some(h) = &mut self.highlighter {
                    let edit = match changes {
                        [change] => {
                            let line_start = self.buffer.line_start(span.first);
                            let last = span.first + span.new_count - 1;
                            let end = change.range.start + change.new_len;
                            let tail = end - self.buffer.line_start(last);
                            let rest = self.buffer.line_len(last).saturating_sub(tail);
                            let start = change.range.start - line_start;
                            Some(LineEdit {
                                start,
                                tail,
                                rest,
                                old_len: (span.old_count == 1)
                                    .then(|| start + change.range.len() + rest),
                            })
                        }
                        _ => None,
                    };
                    h.edited(&self.buffer, span, changes, edit);
                }
                self.folds_edited(span.first, span.old_count, span.new_count);
            }
            None => self.relayout(),
        }
        self.tag_reach = diagnostics::adjust(&mut self.diagnostics, self.tag_reach, changes);
        self.decoration_reach =
            diagnostics::adjust(&mut self.decorations, self.decoration_reach, changes);
        if let Some(scope) = &mut self.search_scope {
            diagnostics::adjust(scope, usize::MAX, changes);
        }
        self.fold_candidates = None;
        self.find();
        let len = self.buffer.len();
        self.selections.clamp(len);
    }

    /// Lays everything out and highlights again (a new text, font or
    /// language).
    pub(crate) fn relayout(&mut self) {
        // The folds past the text's lines (a new text) go.
        let lines = self.buffer.line_count();
        if self.folded.iter().any(|f| f.end >= lines) {
            self.folded = fold_set::normalize(std::mem::take(&mut self.folded), lines);
            self.display.set_folds(fold_set::outermost(&self.folded));
        }
        if let Some(ranges) = &mut self.app_folds {
            *ranges = fold_set::normalize(std::mem::take(ranges), lines);
        }
        self.display.rebuild(&self.buffer);
        if let Some(h) = &mut self.highlighter {
            h.reset(&self.buffer);
        }
        self.fold_candidates = None;
    }

    /// The language and what highlights it (`syntax`: the built-in
    /// highlighter's, or the app's for the language).
    pub(crate) fn set_language(&mut self, language: &'static LanguageConfig, syntax: Syntax) {
        if std::ptr::eq(self.language, language) && self.syntax.same(&syntax) {
            return;
        }
        self.language = language;
        self.syntax = syntax;
        self.highlighter = (self.highlighting && self.syntax.ready())
            .then(|| Highlighter::with(&self.syntax))
            .flatten();
        if let Some(h) = &mut self.highlighter {
            h.reset(&self.buffer);
        }
    }

    // Search.

    /// Finds the search's matches again.
    pub(crate) fn find(&mut self) {
        self.matches.clear();
        self.search_error = None;
        let Some(search) = &self.search else { return };
        if search.query.is_empty() {
            return;
        }
        match search::find_all(&self.buffer, search, MATCH_LIMIT) {
            Ok(matches) => {
                self.matches = match &self.search_scope {
                    Some(scope) => search::within(matches, scope.iter().map(|m| &m.range)),
                    None => matches,
                }
            }
            Err(error) => self.search_error = Some(error),
        }
    }

    /// The match the primary selection is on.
    pub(crate) fn current_match(&self) -> Option<usize> {
        let primary = self.selections.primary().range();
        self.matches.iter().position(|m| *m == primary)
    }

    pub(crate) fn search_result(&self) -> EditorSearchResult {
        EditorSearchResult {
            count: self.matches.len() as u32,
            current: self.current_match().map(|i| i as u32),
            error: self.search_error.clone().map(Into::into),
        }
    }

    // Folds.
    //
    // `folded` is every fold the user folded, nested ones included (as VS
    // Code keeps them): folding a block keeps the folds inside it, so
    // unfolding it shows them folded still. The display map hides the
    // outermost ones.

    /// Where folds can start: the app's `foldRanges` when it gives them,
    /// else the indentation's.
    pub(crate) fn fold_candidates(&mut self) -> &[FoldRange] {
        if self.fold_candidates.is_none() {
            let ranges = if !self.folding {
                Vec::new()
            } else if let Some(ranges) = &self.app_folds {
                ranges.clone()
            } else {
                fold::fold_ranges(&self.buffer, self.options.tab_size)
            };
            self.fold_candidates = Some(ranges);
        }
        self.fold_candidates.as_deref().unwrap_or_default()
    }

    /// The fold that can start on `line`.
    pub(crate) fn fold_at(&mut self, line: usize) -> Option<FoldRange> {
        let candidates = self.fold_candidates();
        candidates
            .binary_search_by_key(&line, |f| f.start)
            .ok()
            .map(|i| candidates[i])
    }

    /// The app's fold ranges (`foldRanges`; None: by indentation).
    pub(crate) fn set_app_folds(&mut self, ranges: Option<Vec<FoldRange>>) {
        let lines = self.buffer.line_count();
        self.app_folds = ranges.map(|ranges| fold_set::normalize(ranges, lines));
        self.fold_candidates = None;
    }

    /// The folded ranges, nested ones included (sorted).
    pub(crate) fn folded(&self) -> &[FoldRange] {
        &self.folded
    }

    /// Folds (`Some(true)`), unfolds (`Some(false)`) or toggles (`None`)
    /// the fold starting on `line`; folding a line no fold starts on folds
    /// the innermost one it is in. Carets inside a new fold move to its
    /// first line's end.
    pub(crate) fn set_fold(&mut self, line: usize, fold: Option<bool>) -> bool {
        let existing = self.folded.iter().position(|f| f.start == line);
        match (existing, fold.unwrap_or(existing.is_none())) {
            (Some(i), false) => {
                self.folded.remove(i);
                self.sync_folds();
                true
            }
            (None, false) => self.unfold_hiding(line),
            (None, true) => {
                let Some(range) = fold_set::fold_for(self.fold_candidates(), line) else {
                    return false;
                };
                self.add_folds(vec![range])
            }
            (Some(_), true) => false,
        }
    }

    /// Folds the fold on `line` (as [`Self::set_fold`] finds it) and every
    /// fold inside it.
    pub(crate) fn fold_recursive(&mut self, line: usize) -> bool {
        let candidates = self.fold_candidates();
        let Some(outer) = fold_set::fold_for(candidates, line) else {
            return false;
        };
        let ranges = fold_set::within(candidates, outer).copied().collect();
        self.add_folds(ranges)
    }

    /// Unfolds the fold on `line` (a folded one starting there, else the
    /// one [`Self::set_fold`] would fold) and every fold inside it.
    pub(crate) fn unfold_recursive(&mut self, line: usize) -> bool {
        let folded = self.folded.iter().find(|f| f.start == line).copied();
        let outer = match folded {
            Some(f) => Some(f),
            None => fold_set::fold_for(self.fold_candidates(), line),
        };
        let Some(outer) = outer else {
            return self.unfold_hiding(line);
        };
        let before = self.folded.len();
        self.folded
            .retain(|f| f.start < outer.start || f.end > outer.end);
        let changed = self.folded.len() != before;
        if changed {
            self.sync_folds();
        }
        changed
    }

    /// Folds every fold at nesting level `level` (1: those inside no
    /// other), leaving the others as they are.
    pub(crate) fn fold_level(&mut self, level: usize) -> bool {
        let candidates = self.fold_candidates();
        let ranges = candidates
            .iter()
            .zip(fold_set::levels(candidates))
            .filter(|(_, l)| *l == level)
            .map(|(f, _)| *f)
            .collect();
        self.add_folds(ranges)
    }

    /// Folds lines `start + 1..=end` under line `start`, whether a fold
    /// can start there or not (a fold of the selection's lines).
    pub(crate) fn fold_lines(&mut self, start: usize, end: usize) -> bool {
        self.add_folds(vec![FoldRange { start, end }])
    }

    /// Folds the lines of every selection that spans several (a selection
    /// ending at a line's start leaves that line out).
    pub(crate) fn fold_selections(&mut self) -> bool {
        let ranges = self
            .selections
            .all()
            .iter()
            .filter_map(|s| {
                let start = self.buffer.line_of(s.start());
                let mut end = self.buffer.line_of(s.end());
                if end > start && self.buffer.line_start(end) == s.end() {
                    end -= 1;
                }
                (end > start).then_some(FoldRange { start, end })
            })
            .collect();
        self.add_folds(ranges)
    }

    /// Folds every fold that can start (`true`), nested ones too, or
    /// unfolds everything.
    pub(crate) fn fold_all(&mut self, fold: bool) {
        if fold {
            let ranges = self.fold_candidates().to_vec();
            self.add_folds(ranges);
        } else if !self.folded.is_empty() {
            self.folded.clear();
            self.sync_folds();
        }
    }

    /// Replaces the folded ranges with `ranges` (the app's `setFolds`), any
    /// lines, not only where folds can start.
    pub(crate) fn set_folds(&mut self, ranges: Vec<FoldRange>) -> bool {
        if !self.folding {
            return false;
        }
        let folds = fold_set::normalize(ranges, self.buffer.line_count());
        if folds == self.folded {
            return false;
        }
        self.folded = folds;
        self.sync_folds();
        self.move_carets_out_of_folds();
        true
    }

    /// Unfolds everything and forgets the folds (`folding` turned off).
    pub(crate) fn clear_folds(&mut self) {
        self.folded.clear();
        self.display.set_folds(Vec::new());
        self.fold_candidates = None;
    }

    /// Unfolds what hides `offset` (a caret moved there, a search match).
    pub(crate) fn reveal(&mut self, offset: usize) {
        let line = self.buffer.line_of(offset);
        if self.display.is_hidden(line) {
            self.unfold_hiding(line);
        }
    }

    /// Unfolds every fold hiding `line`, nested ones included.
    fn unfold_hiding(&mut self, line: usize) -> bool {
        let before = self.folded.len();
        self.folded.retain(|f| !(line > f.start && line <= f.end));
        let changed = self.folded.len() != before;
        if changed {
            self.sync_folds();
        }
        changed
    }

    /// Adds `ranges` to the folded ones; those crossing a folded range's
    /// end (or one another's) are dropped. Carets they hide move to the end
    /// of their fold's first line. Whether anything was folded.
    fn add_folds(&mut self, ranges: Vec<FoldRange>) -> bool {
        if !self.folding || ranges.is_empty() {
            return false;
        }
        let crosses = |a: &FoldRange, b: &FoldRange| {
            (a.start < b.start && b.start <= a.end && a.end < b.end)
                || (b.start < a.start && a.start <= b.end && b.end < a.end)
        };
        let mut folds = self.folded.clone();
        folds.extend(
            ranges
                .into_iter()
                .filter(|range| !self.folded.iter().any(|f| crosses(f, range))),
        );
        let folds = fold_set::normalize(folds, self.buffer.line_count());
        if folds == self.folded {
            return false;
        }
        self.folded = folds;
        self.sync_folds();
        self.move_carets_out_of_folds();
        true
    }

    /// The display map hides the outermost folded ranges.
    fn sync_folds(&mut self) {
        self.display.set_folds(fold_set::outermost(&self.folded));
        self.display.rebuild(&self.buffer);
    }

    /// Selections with an end in a hidden line become a caret at the end
    /// of the fold's first line.
    fn move_carets_out_of_folds(&mut self) {
        let buffer = &self.buffer;
        let display = &self.display;
        let hidden = |offset: usize| display.hiding_fold(buffer.line_of(offset));
        self.selections
            .map(|s| match hidden(s.head).or_else(|| hidden(s.anchor)) {
                Some(fold) => Selection::caret(buffer.line_end(fold.start)),
                None => s,
            });
    }

    /// The folds and the app's ranges after an edit of lines `first..first
    /// + old_count` (now `first..first + new_count`), the display map's
    /// folds already carried ([`DisplayMap::edited`]).
    fn folds_edited(&mut self, first: usize, old_count: usize, new_count: usize) {
        if let Some(ranges) = &mut self.app_folds {
            *ranges = ranges
                .iter()
                .filter_map(|r| fold_set::carry(*r, first, old_count, new_count))
                .collect();
            let lines = self.buffer.line_count();
            *ranges = fold_set::normalize(std::mem::take(ranges), lines);
        }
        if self.folded.is_empty() {
            return;
        }
        self.folded = fold_set::edited(&self.folded, first, old_count, new_count);
        // A fold the edit unfolded may have held folds the edit kept: they
        // hide now.
        if fold_set::outermost(&self.folded) != self.display.folds() {
            self.sync_folds();
        }
    }

    // Positions.

    pub(crate) fn position(&self, offset: usize) -> EditorPosition {
        self.buffer.position(offset)
    }

    pub(crate) fn offset_of(&self, position: EditorPosition) -> usize {
        self.buffer.offset_of(position)
    }

    pub(crate) fn editor_selections(&self) -> Vec<EditorSelection> {
        self.selections
            .all()
            .iter()
            .map(|s| EditorSelection::new(self.position(s.anchor), self.position(s.head)))
            .collect()
    }

    pub(crate) fn set_editor_selections(&mut self, selections: &[EditorSelection]) {
        let all: Vec<Selection> = selections
            .iter()
            .map(|s| Selection::new(self.offset_of(s.anchor), self.offset_of(s.head)))
            .collect();
        let primary = all.len().saturating_sub(1);
        self.selections = Selections::new(all, primary);
        self.buffer.break_undo_group();
    }

    /// The offset at `point` of the rows' box (a press).
    pub(crate) fn offset_at(&self, point: Pt<Points>) -> usize {
        let lh = self.line_height().0.max(1.0);
        let rows = self.display.row_count();
        let row = ((point.y.0 / lh).floor().max(0.0) as usize).min(rows.saturating_sub(1));
        let before = self.buffer.snapshot();
        let layout = self.display.layout(&before);
        // The layout's x counts a continuation row's indent itself.
        layout.offset_at(row, point.x.max(px(0.0)))
    }

    /// Where `offset` is drawn: its row's top left and its x.
    pub(crate) fn caret_point(&self, offset: usize) -> Pt<Points> {
        let before = self.buffer.snapshot();
        let layout = self.display.layout(&before);
        // The x counts a continuation row's indent.
        let (row, x) = layout.locate(offset);
        Pt::new(x, self.line_height() * row as f32)
    }

    /// How many rows a page moves: the viewport's height in rows, less
    /// one kept for context.
    pub(crate) fn page_rows(&self, viewport: Points) -> usize {
        ((viewport.0 / self.line_height().0.max(1.0)) as usize)
            .saturating_sub(1)
            .max(1)
    }

    // What the view draws.

    /// The content of display row `row`.
    pub(crate) fn row_content(&self, row: usize) -> RowContent {
        if row >= self.display.row_count() {
            return RowContent::default();
        }
        let info = self.display.row(row).clone();
        let row_text = self.display.row_text(&self.buffer, row);
        let line_start = self.buffer.line_start(info.line);
        // Boundaries where the style changes, in buffer offsets.
        let mut cuts: Vec<usize> = vec![info.range.start, info.range.end];
        let tokens = self
            .highlighter
            .as_ref()
            .filter(|_| self.highlighting)
            .and_then(|h| h.tokens(info.line))
            .unwrap_or_default();
        for (range, _) in tokens {
            cuts.push(line_start + range.start);
            cuts.push(line_start + range.end);
        }
        let decorations: Vec<(usize, Range<usize>)> = app_highlight::near(
            &self.decorations,
            self.decoration_reach,
            info.range.start,
            info.range.end,
        )
        .filter(|(_, m)| m.range.start < info.range.end && m.range.end > info.range.start)
        .filter(|(_, m)| {
            let d = &self.decoration_items[m.item];
            d.class.is_some() || d.style.is_some() || d.token.is_some()
        })
        .map(|(i, m)| (i, m.range.clone()))
        .collect();
        for (_, r) in &decorations {
            cuts.push(r.start);
            cuts.push(r.end);
        }
        let tagged: Vec<(SpanTags, Range<usize>)> = app_highlight::near(
            &self.diagnostics,
            self.tag_reach,
            info.range.start,
            info.range.end,
        )
        .map(|(_, m)| (SpanTags::of(&m.item), self.marked_range(m.range.clone())))
        .filter(|(tags, r)| {
            !tags.is_empty() && r.start < info.range.end && r.end > info.range.start
        })
        .collect();
        for (_, r) in &tagged {
            cuts.push(r.start);
            cuts.push(r.end);
        }
        cuts.retain(|c| *c >= info.range.start && *c <= info.range.end);
        cuts.sort_unstable();
        cuts.dedup();
        let mut spans: Vec<Span> = Vec::new();
        for pair in cuts.windows(2) {
            let (start, end) = (pair[0], pair[1]);
            if start >= end {
                continue;
            }
            let display = row_text.display_range(start..end);
            let text = row_text.text[display].to_owned();
            if text.is_empty() {
                continue;
            }
            let token = app_highlight::token(
                &decorations,
                &self.decorations,
                &self.decoration_items,
                start..end,
            )
            .or_else(|| {
                tokens
                    .iter()
                    .find(|(r, _)| line_start + r.start <= start && line_start + r.end >= end)
                    .map(|(_, t)| *t)
            });
            let decorations: Vec<usize> = decorations
                .iter()
                .filter(|(_, r)| r.start <= start && r.end >= end)
                .map(|(i, _)| self.decorations[*i].item)
                .collect();
            let tags = tagged
                .iter()
                .filter(|(_, r)| r.start <= start && r.end >= end)
                .fold(SpanTags::default(), |all, (t, _)| all.union(*t));
            match spans.last_mut() {
                Some(last)
                    if last.token == token
                        && last.decorations == decorations
                        && last.tags == tags =>
                {
                    last.text.push_str(&text);
                }
                _ => spans.push(Span {
                    text,
                    token,
                    decorations,
                    tags,
                }),
            }
        }
        let folded = info.first
            && self
                .display
                .folds()
                .binary_search_by_key(&info.line, |f| f.start)
                .is_ok()
            && self.row_is_last_of_line(row);
        let line_decorations = app_highlight::near(
            &self.decorations,
            self.decoration_reach,
            line_start,
            self.buffer.line_end(info.line),
        )
        .map(|(_, m)| m)
        .filter(|m| {
            let first = self.buffer.line_of(m.range.start);
            let last = self.buffer.line_of(m.range.end);
            info.line >= first && info.line <= last
        })
        .map(|m| m.item)
        .filter(|i| {
            let d = &self.decoration_items[*i];
            d.line_class.is_some() || d.line_style.is_some()
        })
        .collect();
        RowContent {
            spans,
            folded,
            line_decorations,
        }
    }

    /// The diagnostics that can overlap bytes `low..=high`, by start: those
    /// starting from the longest one's bytes before `low` up to `high`.
    pub(crate) fn diagnostics_near(
        &self,
        low: usize,
        high: usize,
    ) -> impl Iterator<Item = &Mark<EditorDiagnostic>> {
        app_highlight::near(&self.diagnostics, self.tag_reach, low, high).map(|(_, mark)| mark)
    }

    /// Sets the diagnostics, resolved.
    pub(crate) fn set_diagnostics(&mut self, marks: Vec<Mark<EditorDiagnostic>>) {
        self.tag_reach = app_highlight::reach(&marks);
        self.diagnostics = marks;
    }

    /// Sets the decorations, resolved (`marks`) and as the app gave them.
    pub(crate) fn set_decorations(
        &mut self,
        marks: Vec<Mark<usize>>,
        items: Vec<EditorDecoration>,
    ) {
        self.decoration_reach = app_highlight::reach(&marks);
        self.decorations = marks;
        self.decoration_items = items;
    }

    fn row_is_last_of_line(&self, row: usize) -> bool {
        row + 1 >= self.display.row_count() || self.display.row(row + 1).first
    }

    /// What the gutter shows on row `row`.
    pub(crate) fn gutter_row(&mut self, row: usize) -> GutterRow {
        if row >= self.display.row_count() {
            return GutterRow::default();
        }
        let info = self.display.row(row).clone();
        if !info.first {
            return GutterRow::default();
        }
        let line = info.line;
        let start = self.buffer.line_start(line);
        let end = self.buffer.line_end(line);
        let active = self
            .selections
            .all()
            .iter()
            .any(|s| s.head >= start && s.head <= end);
        let folded = self
            .display
            .folds()
            .binary_search_by_key(&line, |f| f.start)
            .is_ok();
        let fold = if folded {
            Some(true)
        } else if self.folding && self.fold_at(line).is_some() {
            Some(false)
        } else {
            None
        };
        let severity =
            diagnostics::line_severities(&self.diagnostics, &self.buffer, line..line + 1)
                .into_iter()
                .next()
                .map(|(_, s)| s);
        GutterRow {
            number: Some(line + 1),
            active,
            fold,
            severity,
        }
    }

    /// The rectangles of `range` on rows `rows`, one per row it covers;
    /// `newline` adds a sliver after a row whose line break is selected.
    pub(crate) fn range_rects(
        &self,
        range: Range<usize>,
        rows: Range<usize>,
        newline: bool,
    ) -> Vec<Rect> {
        let mut out = Vec::new();
        if range.is_empty() && !newline {
            return out;
        }
        let lh = self.line_height();
        let before = self.buffer.snapshot();
        let layout = self.display.layout(&before);
        let (first_row, _) = layout.locate(range.start);
        let (last_row, _) = layout.locate(range.end);
        let space = self.display.space_width();
        for row in first_row.max(rows.start)..=last_row.min(rows.end.saturating_sub(1)) {
            let info = self.display.row(row);
            let start = range.start.max(info.range.start);
            let end = range.end.min(info.range.end);
            let x0 = if start <= info.range.start {
                px(0.0)
            } else {
                self.display.x_in(&self.buffer, row, start)
            };
            let mut x1 = self.display.x_in(&self.buffer, row, end);
            // The line break, or the wrap, is selected: a sliver past
            // the end.
            if newline && range.end > info.range.end {
                x1 += space;
            }
            if x1 > x0 {
                out.push(Bounds::new(
                    Pt::new(x0, lh * row as f32),
                    Size::new(x1 - x0, lh),
                ));
            }
        }
        out
    }

    /// The selections' rectangles on `rows`.
    pub(crate) fn selection_rects(&self, rows: Range<usize>) -> Vec<Rect> {
        let mut out = Vec::new();
        for s in self.selections.all() {
            if s.is_empty() {
                continue;
            }
            out.extend(self.range_rects(s.range(), rows.clone(), true));
        }
        out
    }

    /// The carets on `rows`: their top left (the caret is 2 points wide and
    /// a line tall).
    pub(crate) fn caret_points(&self, rows: Range<usize>) -> Vec<Pt<Points>> {
        let lh = self.line_height();
        self.selections
            .all()
            .iter()
            .map(|s| self.caret_point(s.head))
            .filter(|p| {
                let row = (p.y.0 / lh.0.max(1.0)).round() as usize;
                rows.contains(&row)
            })
            .collect()
    }

    /// The rows the carets are on (the active lines' rows: every row of
    /// their lines).
    pub(crate) fn active_rows(&self, rows: Range<usize>) -> Vec<usize> {
        let mut out = Vec::new();
        for s in self.selections.all() {
            if !s.is_empty() {
                continue;
            }
            let line = self.buffer.line_of(s.head);
            let first = self.display.line_row(line);
            let mut row = first;
            while row < self.display.row_count() && (row == first || !self.display.row(row).first) {
                if rows.contains(&row) && !out.contains(&row) {
                    out.push(row);
                }
                row += 1;
            }
        }
        out
    }

    /// The search matches' rectangles on `rows`, with whether each is the
    /// current one.
    pub(crate) fn match_rects(&self, rows: Range<usize>) -> Vec<(Rect, bool)> {
        let current = self.current_match();
        let (start, end) = self.rows_offsets(rows.clone());
        let first = self.matches.partition_point(|m| m.end < start);
        let mut out = Vec::new();
        for (i, m) in self.matches[first..].iter().enumerate() {
            if m.start > end {
                break;
            }
            for r in self.range_rects(m.clone(), rows.clone(), false) {
                out.push((r, current == Some(first + i)));
            }
        }
        out
    }

    /// What a diagnostic over `range` marks: the range, else the char
    /// after it, else the one before it (the end of a line).
    fn marked_range(&self, mut range: Range<usize>) -> Range<usize> {
        if range.is_empty() {
            let next = movement::next_grapheme(&self.buffer, range.start);
            let line_end = self.buffer.line_end(self.buffer.line_of(range.start));
            range.end = next.min(line_end.max(range.start));
            if range.is_empty() && range.start > 0 {
                let line_start = self.buffer.line_start(self.buffer.line_of(range.start));
                range.start = movement::prev_grapheme(&self.buffer, range.start).max(line_start);
            }
        }
        range
    }

    /// The marks on `rows` of the diagnostics with no text to underline
    /// (on an empty line): a space wide line under the row, and their
    /// severity. The others underline their text (`row_content`).
    pub(crate) fn diagnostic_rects(
        &self,
        rows: Range<usize>,
    ) -> Vec<(Rect, EditorDiagnosticSeverity)> {
        let (start, end) = self.rows_offsets(rows.clone());
        let mut out = Vec::new();
        for mark in self.diagnostics_near(start, end) {
            if mark.range.end < start {
                continue;
            }
            if SpanTags::of(&mark.item).severity.is_none() {
                continue;
            }
            let range = self.marked_range(mark.range.clone());
            if !range.is_empty() {
                continue;
            }
            let at = self.caret_point(range.start);
            let row = (at.y.0 / self.line_height().0.max(1.0)).round() as usize;
            if !rows.contains(&row) {
                continue;
            }
            let size = Size::new(self.display.space_width(), self.line_height());
            out.push((Bounds::new(at, size), mark.item.severity));
        }
        out
    }

    /// The bracket at the primary caret and its partner: their
    /// rectangles.
    pub(crate) fn bracket_rects(&self, rows: Range<usize>) -> Vec<Rect> {
        let primary = self.selections.primary();
        if !primary.is_empty() {
            return Vec::new();
        }
        let Some((open, close)) =
            movement::matching_bracket(&self.buffer, primary.head, self.language.brackets)
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for at in [open, close] {
            let end = movement::next_grapheme(&self.buffer, at);
            out.extend(self.range_rects(at..end, rows.clone(), false));
        }
        out
    }

    /// The indent guides on `rows`: their x and the rows they span (one
    /// guide per level of the lines' indentation, blank lines taking the
    /// next line's).
    pub(crate) fn indent_guides(&self, rows: Range<usize>) -> Vec<(Points, Range<usize>)> {
        let tab = self.options.tab_size.max(1) as usize;
        let space = self.display.space_width();
        let mut columns: Vec<Option<usize>> = Vec::new();
        for row in rows.clone() {
            if row >= self.display.row_count() {
                columns.push(Some(0));
                continue;
            }
            let info = self.display.row(row);
            if !info.first {
                columns.push(None);
                continue;
            }
            columns.push(Some(self.indent_columns(info.line)));
        }
        // Blank lines take the indentation around them.
        for i in 0..columns.len() {
            if columns[i] == Some(usize::MAX) {
                let next = columns[i..]
                    .iter()
                    .flatten()
                    .find(|c| **c != usize::MAX)
                    .copied()
                    .unwrap_or(0);
                let prev = columns[..i]
                    .iter()
                    .rev()
                    .flatten()
                    .find(|c| **c != usize::MAX)
                    .copied()
                    .unwrap_or(0);
                columns[i] = Some(next.min(prev));
            }
        }
        let mut out: Vec<(Points, Range<usize>)> = Vec::new();
        let mut open: Vec<(usize, usize)> = Vec::new(); // (level, first row)
        let mut last_indent = 0usize;
        for (i, row) in rows.clone().enumerate() {
            let indent = match columns.get(i).copied().flatten() {
                Some(c) => c,
                None => last_indent,
            };
            last_indent = indent;
            let levels = indent / tab;
            while open.len() > levels {
                let (level, first) = open.pop().unwrap_or_default();
                out.push((space * (level * tab) as f32, first..row));
            }
            while open.len() < levels {
                open.push((open.len(), row));
            }
        }
        for (level, first) in open {
            out.push((space * (level * tab) as f32, first..rows.end));
        }
        out.retain(|(_, r)| !r.is_empty());
        out
    }

    /// The columns of `line`'s indentation, `usize::MAX` for a blank line.
    fn indent_columns(&self, line: usize) -> usize {
        let tab = self.options.tab_size.max(1) as usize;
        let mut columns = 0;
        for ch in self.buffer.chars_at(self.buffer.line_start(line)) {
            match ch {
                ' ' => columns += 1,
                '\t' => columns = (columns / tab + 1) * tab,
                '\n' => return usize::MAX,
                _ => return columns,
            }
        }
        usize::MAX
    }

    /// The text offsets rows `rows` cover.
    fn rows_offsets(&self, rows: Range<usize>) -> (usize, usize) {
        let count = self.display.row_count();
        if count == 0 {
            return (0, 0);
        }
        let first = self.display.row(rows.start.min(count - 1)).range.start;
        let last = self
            .display
            .row(rows.end.saturating_sub(1).min(count - 1))
            .range
            .end;
        (first, last)
    }

    /// The size of the rows' box: the widest row (without soft wrap) and
    /// every row's height.
    pub(crate) fn content_size(&self) -> Size<Points> {
        let lh = self.line_height();
        Size::new(
            self.display.widest_row() + self.display.space_width() * 2.0,
            lh * self.display.row_count() as f32,
        )
    }

    /// Clears what the app set that refers to the old text (a new value
    /// from the app).
    pub(crate) fn primary_head(&self) -> usize {
        self.selections.primary().head
    }

    /// The built-in language a name or path names (the controller also
    /// finds the engine's own: `languages::resolve`).
    #[cfg(test)]
    pub(crate) fn language_for(name: Option<&str>) -> &'static LanguageConfig {
        super::language::language(name.unwrap_or(""))
    }

    /// The marks of the whitespace on `rows` (`showWhitespaces`): where
    /// each run of spaces or tab is and what shows there, a `·` per space
    /// and a `→` per tab.
    pub(crate) fn whitespace_marks(&self, rows: Range<usize>) -> Vec<(Rect, String)> {
        let lh = self.line_height();
        let count = self.display.row_count();
        let mut out = Vec::new();
        for row in rows.start.min(count)..rows.end.min(count) {
            for ws in self.display.whitespace(&self.buffer, row) {
                let mark = if ws.tab {
                    "→".to_owned()
                } else {
                    "·".repeat(ws.count)
                };
                let at = Pt::new(ws.x, lh * row as f32);
                out.push((Bounds::new(at, Size::new(ws.width, lh)), mark));
            }
        }
        out
    }

    /// The x of each ruler at `columns` in the rows' box (a column is a
    /// space wide).
    pub(crate) fn ruler_xs(&self, columns: &[u32]) -> Vec<Points> {
        let space = self.display.space_width();
        columns.iter().map(|c| space * *c as f32).collect()
    }
}

// It times syntect too.
#[cfg(all(test, feature = "highlight"))]
mod bench {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::editor::commands::Outcome;

    /// `n` lines of Rust-like code.
    fn source(n: usize) -> String {
        let mut text = String::from("fn main() {\n");
        for i in 0..n {
            text.push_str(&format!(
                "    let value_{i} = compute({i}, \"row {i}\") + offset; // line {i}\n"
            ));
        }
        text.push_str("}\n");
        text
    }

    fn state(text: &str) -> State {
        let font = Font {
            family: "monospace".into(),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|s: &str| px(s.chars().count() as f32 * 8.0));
        State::new(
            text,
            State::language_for(Some("rust")),
            EditOptions::default(),
            font,
            measure,
        )
    }

    fn time<R>(label: &str, f: impl FnOnce() -> R) -> R {
        let start = Instant::now();
        let r = f();
        eprintln!("{label}: {:?}", start.elapsed());
        r
    }

    /// The costs of a 200 000 line text: opening it, typing in it, finding
    /// in it and highlighting it.
    #[test]
    #[ignore]
    fn bench_large_text() {
        let text = time("source", || source(200_000));
        eprintln!("{} bytes", text.len());
        let mut st = time("State::new", || state(&text));
        time("buffer.text", || st.buffer.text());
        time("fold candidates", || st.fold_candidates().len());
        time("content size", || st.content_size());
        let end = st.buffer.len();
        st.selections = Selections::single(Selection::caret(end / 2));
        for round in 0..3 {
            time(&format!("type {round}"), || {
                if let Outcome::Edited(changes) = st.editing(40, |e| e.insert("x")) {
                    st.changed(&changes);
                }
            });
        }
        st.search = Some(EditorSearch {
            query: "offset".into(),
            ..Default::default()
        });
        time("find", || st.find());
        time("type with a search", || {
            if let Outcome::Edited(changes) = st.editing(40, |e| e.insert("y")) {
                st.changed(&changes);
            }
        });
        Highlighter::load();
        let mut h = Highlighter::new("rs").unwrap();
        let rope = st.buffer.rope().clone();
        {
            use syntect::parsing::{ParseState, ScopeStack};
            let syntax = crate::syntax::find_syntax("rs").unwrap();
            let set = crate::syntax::syntaxes();
            let lines: Vec<String> = text
                .split_inclusive('\n')
                .take(20_000)
                .map(String::from)
                .collect();
            time("raw syntect, 20 000 lines", || {
                let mut parser = ParseState::new(syntax);
                let mut scopes = ScopeStack::new();
                for line in &lines {
                    for (_, op) in parser.parse_line(line, set).unwrap() {
                        let _ = scopes.apply(&op);
                    }
                }
            });
            time("raw syntect + state clones, 20 000 lines", || {
                let mut parser = ParseState::new(syntax);
                let mut scopes = ScopeStack::new();
                let mut kept = Vec::new();
                for line in &lines {
                    for (_, op) in parser.parse_line(line, set).unwrap() {
                        let _ = scopes.apply(&op);
                    }
                    kept.push((parser.clone(), scopes.clone()));
                }
                kept.len()
            });
            let mut h = Highlighter::new("rs").unwrap();
            let rope = st.buffer.rope().clone();
            time("ours, 20 000 lines", || {
                h.highlight(&rope, 19_999, Duration::from_secs(100))
            });
        }
        time("highlight the first screen", || {
            h.highlight(&rope, 60, Duration::from_secs(10))
        });
        let mut far = Highlighter::new("rs").unwrap();
        let first = 199_000;
        let guess = far
            .guess(
                &rope,
                first - 40,
                st.buffer.line_start(first - 40),
                first + 60,
            )
            .unwrap();
        time("guess 100 lines at line 199 000", || {
            far.guessed(guess.run())
        });
        if std::env::var_os("NSH_BENCH_ALL").is_some() {
            time("highlight to the end", || {
                h.highlight(&rope, st.buffer.line_count() - 1, Duration::from_secs(100))
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::buffer::EditKind;

    /// Folds by indentation: lines 0..=4 under line 0, 1..=2 under line 1.
    const TEXT: &str = "fn a() {\n    if x {\n        y();\n    }\n    z();\n}\nw\n";

    fn state(text: &str) -> State {
        let font = Font {
            family: "monospace".into(),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|text: &str| px(text.chars().count() as f32 * 8.0));
        State::new(
            text,
            &crate::editor::language::PLAIN_TEXT,
            EditOptions::default(),
            font,
            measure,
        )
    }

    #[test]
    fn a_wrapped_rows_carets_and_selections_count_its_indent_once() {
        let mut st = state("    aaaa bbbb cccc dddd\n");
        st.display.set_wrap_width(Some(px(80.0)));
        st.relayout();
        // The line wraps; its continuation rows start at its indentation.
        let row = st.display.row(1);
        assert!(!row.first && row.indent == px(32.0), "{:?}", row.indent);
        let start = row.range.start;
        // A caret after the row's first char: the indent and one char.
        let caret = st.caret_point(start + 1);
        assert_eq!(caret, Pt::new(px(40.0), px(20.0)));
        // A press there finds it again.
        assert_eq!(st.offset_at(Pt::new(px(41.0), px(30.0))), start + 1);
        // Selecting the line covers the first row to its end, not to
        // where the next row starts.
        let first_end = st.display.row(0).range.end;
        let rects = st.range_rects(0..first_end + 2, 0..3, false);
        assert_eq!(
            rects[0].size.width,
            st.display.x_in(&st.buffer, 0, first_end)
        );
        assert_eq!(rects[1].origin.x, px(0.0));
        assert_eq!(rects[1].size.width, px(48.0));
    }

    fn pairs(folds: &[FoldRange]) -> Vec<(usize, usize)> {
        folds.iter().map(|f| (f.start, f.end)).collect()
    }

    fn insert(st: &mut State, at: usize, text: &str) {
        let selections = st.selections.clone();
        let changes = st.buffer.edit(
            vec![(at..at, text.to_owned())],
            &selections,
            &selections,
            EditKind::Typing,
        );
        st.changed(&changes);
    }

    #[test]
    fn folds_inside_a_fold_stay_folded() {
        let mut st = state(TEXT);
        assert!(st.set_fold(1, Some(true)));
        assert!(st.set_fold(0, Some(true)));
        assert_eq!(pairs(st.folded()), vec![(0, 4), (1, 2)]);
        assert_eq!(pairs(st.display.folds()), vec![(0, 4)]);
        // Folding again changes nothing.
        assert!(!st.set_fold(0, Some(true)));
        // Unfolding the outer fold shows the inner one folded.
        assert!(st.set_fold(0, None));
        assert_eq!(pairs(st.display.folds()), vec![(1, 2)]);
        assert!(st.display.is_hidden(2) && !st.display.is_hidden(3));
    }

    #[test]
    fn folding_inside_a_block_folds_it() {
        let mut st = state(TEXT);
        // No fold starts on line 4: the innermost one it is in folds.
        assert!(st.set_fold(4, Some(true)));
        assert_eq!(pairs(st.folded()), vec![(0, 4)]);
        assert!(!st.set_fold(6, Some(true)));
        // Unfolding a hidden line unfolds what hides it.
        assert!(st.set_fold(2, Some(false)));
        assert!(st.folded().is_empty());
    }

    #[test]
    fn recursive_folds_and_levels() {
        let mut st = state(TEXT);
        assert!(st.fold_recursive(0));
        assert_eq!(pairs(st.folded()), vec![(0, 4), (1, 2)]);
        assert!(st.unfold_recursive(0));
        assert!(st.folded().is_empty());
        assert!(!st.unfold_recursive(6));

        assert!(st.fold_level(2));
        assert_eq!(pairs(st.folded()), vec![(1, 2)]);
        assert!(!st.fold_level(3));
        assert!(st.fold_level(1));
        assert_eq!(pairs(st.folded()), vec![(0, 4), (1, 2)]);
        st.fold_all(false);
        assert!(st.folded().is_empty() && st.display.folds().is_empty());
        st.fold_all(true);
        assert_eq!(pairs(st.folded()), vec![(0, 4), (1, 2)]);
    }

    #[test]
    fn carets_leave_what_folds() {
        let mut st = state(TEXT);
        let inside = st.buffer.line_start(2) + 4;
        st.selections = Selections::single(Selection::new(st.buffer.line_start(1), inside));
        assert!(st.set_fold(1, Some(true)));
        let end_of_first = st.buffer.line_end(1);
        assert_eq!(st.selections.all(), &[Selection::caret(end_of_first)]);
    }

    #[test]
    fn a_selections_lines_fold() {
        let mut st = state(TEXT);
        // Lines 4 and 5, the selection ending at line 6's start.
        let (start, end) = (st.buffer.line_start(4), st.buffer.line_start(6));
        st.selections = Selections::single(Selection::new(start, end));
        assert!(st.fold_selections());
        assert_eq!(pairs(st.folded()), vec![(4, 5)]);
        assert_eq!(st.gutter_row(st.display.line_row(4)).fold, Some(true));
        // A selection on one line folds nothing.
        st.fold_all(false);
        st.selections = Selections::single(Selection::new(start, start + 2));
        assert!(!st.fold_selections());
        // Any lines fold by hand; lines crossing a folded range's end do
        // not.
        assert!(st.fold_lines(5, 6));
        assert!(!st.fold_lines(4, 5));
        assert_eq!(pairs(st.folded()), vec![(5, 6)]);
        assert!(st.fold_lines(4, 6));
        assert_eq!(pairs(st.folded()), vec![(4, 6), (5, 6)]);
    }

    #[test]
    fn folds_follow_edits() {
        let mut st = state(TEXT);
        st.set_fold(1, Some(true));
        // A line inserted above shifts the fold.
        insert(&mut st, 0, "// c\n");
        assert_eq!(pairs(st.folded()), vec![(2, 3)]);
        assert_eq!(pairs(st.display.folds()), vec![(2, 3)]);
        // An edit on an outer fold's first line unfolds it; the fold
        // inside it stays folded and hides its lines now.
        st.fold_recursive(1);
        assert_eq!(pairs(st.folded()), vec![(1, 5), (2, 3)]);
        let at = st.buffer.line_start(1);
        insert(&mut st, at, "x");
        assert_eq!(pairs(st.folded()), vec![(2, 3)]);
        assert_eq!(pairs(st.display.folds()), vec![(2, 3)]);
        assert!(st.display.is_hidden(3) && !st.display.is_hidden(2));
    }

    #[test]
    fn the_apps_ranges_replace_the_indentation() {
        let mut st = state(TEXT);
        st.set_app_folds(Some(vec![FoldRange { start: 0, end: 5 }]));
        assert_eq!(pairs(st.fold_candidates()), vec![(0, 5)]);
        assert_eq!(st.fold_at(1), None);
        // Carried through edits until the app gives new ones: lines
        // inserted inside a range grow it.
        let at = st.buffer.line_start(2);
        insert(&mut st, at, "\n");
        assert_eq!(pairs(st.fold_candidates()), vec![(0, 6)]);
        st.set_app_folds(Some(Vec::new()));
        assert!(st.fold_candidates().is_empty());
        st.set_app_folds(None);
        assert_eq!(pairs(st.fold_candidates()), vec![(0, 5), (1, 3)]);
    }

    #[test]
    fn the_apps_folds() {
        let mut st = state(TEXT);
        let ranges = vec![
            FoldRange { start: 1, end: 2 },
            FoldRange { start: 0, end: 4 },
        ];
        assert!(st.set_folds(ranges.clone()));
        assert!(!st.set_folds(ranges));
        assert_eq!(pairs(st.folded()), vec![(0, 4), (1, 2)]);
        // Revealing a hidden line unfolds every fold hiding it.
        let offset = st.buffer.line_start(2);
        st.reveal(offset);
        assert!(st.folded().is_empty());
        // Folding turned off forgets the folds and refuses new ones.
        st.set_folds(vec![FoldRange { start: 0, end: 4 }]);
        st.folding = false;
        st.clear_folds();
        assert!(st.folded().is_empty() && st.display.folds().is_empty());
        assert!(!st.set_folds(vec![FoldRange { start: 0, end: 4 }]));
        assert!(!st.fold_recursive(0));
    }

    fn decorate(st: &mut State, items: Vec<EditorDecoration>) {
        let indexes: Vec<usize> = (0..items.len()).collect();
        let marks = diagnostics::resolve(&st.buffer, &indexes, |i| items[*i].range);
        st.set_decorations(marks, items);
    }

    fn decoration(line: u32, from: u32, to: u32) -> EditorDecoration {
        EditorDecoration {
            range: crate::editor::EditorRange::new(
                EditorPosition::new(line, from),
                EditorPosition::new(line, to),
            ),
            ..Default::default()
        }
    }

    fn spans(st: &State, line: usize) -> Vec<(String, Option<Token>, usize)> {
        st.row_content(st.display.line_row(line))
            .spans
            .into_iter()
            .map(|span| (span.text, span.token, span.decorations.len()))
            .collect()
    }

    #[test]
    fn the_apps_tokens_color_the_text() {
        use crate::editor::EditorToken;
        let mut st = state("let x = 1;\nfn f() {}\n");
        let keyword = EditorDecoration {
            token: Some(EditorToken::Keyword),
            ..decoration(0, 0, 3)
        };
        // A token inside another: the inner one wins its range.
        let outer = EditorDecoration {
            token: Some(EditorToken::String),
            ..decoration(1, 0, 9)
        };
        let inner = EditorDecoration {
            token: Some(EditorToken::Title),
            ..decoration(1, 3, 4)
        };
        // A class alone styles over the syntax's token, not instead of it.
        let class = EditorDecoration {
            class: Some("underline".into()),
            ..decoration(0, 8, 9)
        };
        decorate(&mut st, vec![keyword, outer, inner, class]);
        assert_eq!(
            spans(&st, 0),
            vec![
                ("let".to_owned(), Some(Token::Keyword), 1),
                (" x = ".to_owned(), None, 0),
                ("1".to_owned(), None, 1),
                (";".to_owned(), None, 0),
            ]
        );
        assert_eq!(
            spans(&st, 1),
            vec![
                ("fn ".to_owned(), Some(Token::String), 1),
                ("f".to_owned(), Some(Token::Title), 2),
                ("() {}".to_owned(), Some(Token::String), 1),
            ]
        );
    }

    #[test]
    fn rows_find_their_decorations_among_many() {
        let text: String = (0..2000).map(|i| format!("line {i}\n")).collect();
        let mut st = state(&text);
        let mut items: Vec<EditorDecoration> = (0..2000)
            .map(|line| EditorDecoration {
                class: Some("font-bold".into()),
                ..decoration(line, 0, 4)
            })
            .collect();
        // One long decoration from line 10 to line 1500, behind the rows.
        items.push(EditorDecoration {
            range: crate::editor::EditorRange::new(
                EditorPosition::new(10, 0),
                EditorPosition::new(1500, 0),
            ),
            line_class: Some("bg-muted".into()),
            ..Default::default()
        });
        decorate(&mut st, items);
        assert_eq!(
            spans(&st, 1200),
            vec![("line".to_owned(), None, 1), (" 1200".to_owned(), None, 0)]
        );
        let row = st.display.line_row(1200);
        assert_eq!(st.row_content(row).line_decorations, vec![2000]);
        let row = st.display.line_row(1600);
        assert!(st.row_content(row).line_decorations.is_empty());
        // Edits keep the window right: a line inserted above shifts all.
        insert(&mut st, 0, "\n");
        assert_eq!(spans(&st, 1201)[0], ("line".to_owned(), None, 1));
    }

    fn diagnose(st: &mut State, items: Vec<EditorDiagnostic>) {
        let marks = diagnostics::resolve(&st.buffer, &items, |d| d.range);
        st.set_diagnostics(marks);
    }

    fn tagged_diagnostic(
        from: (u32, u32),
        to: (u32, u32),
        severity: EditorDiagnosticSeverity,
        tags: Vec<EditorDiagnosticTag>,
    ) -> EditorDiagnostic {
        EditorDiagnostic {
            range: crate::editor::EditorRange::new(
                EditorPosition::new(from.0, from.1),
                EditorPosition::new(to.0, to.1),
            ),
            severity,
            tags,
            ..Default::default()
        }
    }

    fn tag_spans(st: &State, line: usize) -> Vec<(String, bool, bool)> {
        st.row_content(st.display.line_row(line))
            .spans
            .into_iter()
            .map(|span| (span.text, span.tags.unnecessary, span.tags.deprecated))
            .collect()
    }

    #[test]
    fn tagged_diagnostics_fade_and_strike_their_text() {
        use EditorDiagnosticSeverity::*;
        use EditorDiagnosticTag::*;
        let mut st = state("let unused = old();\nkeep\nfirst\nsecond\nthird\n");
        diagnose(
            &mut st,
            vec![
                tagged_diagnostic((0, 4), (0, 10), Hint, vec![Unnecessary]),
                tagged_diagnostic((0, 13), (0, 16), Warning, vec![Deprecated]),
                // Both tags over one span; an untagged diagnostic cuts
                // nothing.
                tagged_diagnostic((0, 4), (0, 6), Info, vec![Deprecated]),
                tagged_diagnostic((1, 0), (1, 4), Error, vec![]),
                // A long one, from line 2 into line 4.
                tagged_diagnostic((2, 2), (4, 2), Hint, vec![Unnecessary]),
            ],
        );
        assert_eq!(
            tag_spans(&st, 0),
            vec![
                ("let ".to_owned(), false, false),
                ("un".to_owned(), true, true),
                ("used".to_owned(), true, false),
                (" = ".to_owned(), false, false),
                ("old".to_owned(), false, true),
                ("();".to_owned(), false, false),
            ]
        );
        assert_eq!(tag_spans(&st, 1), vec![("keep".to_owned(), false, false)]);
        assert_eq!(tag_spans(&st, 3), vec![("second".to_owned(), true, false)]);
        assert_eq!(
            tag_spans(&st, 4),
            vec![
                ("th".to_owned(), true, false),
                ("ird".to_owned(), false, false)
            ]
        );
        // Carried through an edit above it.
        insert(&mut st, 0, "\n");
        assert_eq!(tag_spans(&st, 4), vec![("second".to_owned(), true, false)]);
        // Tagged hints draw no underline under their text; the others
        // underline it in their severity's color, the most serious on top.
        let severities = |st: &State, line: usize| -> Vec<_> {
            st.row_content(st.display.line_row(line))
                .spans
                .into_iter()
                .map(|span| span.tags.severity)
                .collect()
        };
        assert_eq!(
            severities(&st, 1),
            vec![None, Some(Info), None, None, Some(Warning), None]
        );
        assert_eq!(severities(&st, 2), vec![Some(Error)]);
        // Text to underline: no mark of their own.
        assert!(st.diagnostic_rects(0..st.display.row_count()).is_empty());
        // On an empty line, a mark of its own.
        diagnose(
            &mut st,
            vec![tagged_diagnostic((0, 0), (0, 0), Error, vec![])],
        );
        let marks = st.diagnostic_rects(0..st.display.row_count());
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].1, Error);
    }
}
