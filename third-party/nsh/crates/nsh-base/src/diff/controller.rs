//! The diff view's controller: the two texts, their model and rows, the
//! revisions bindings subscribe to, and what props and the ref do to them.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ops::Range,
    rc::Rc,
};

use nsh_core::prelude::*;
use ropey::Rope;

use super::{
    DiffAnnotation, DiffChange, DiffExpand, DiffFile, DiffHunk, DiffInline, DiffLayout,
    DiffLineRange, DiffSide, DiffStats, DiffViewEvent, DiffViewProps,
    files::{self, Files, Joined, Segment},
    geometry::{self, Geometry},
    layout::{self, Expansions, Header, Layout, Options, Row},
    model::{self, DiffModel, InlineMode, Pair},
};
use crate::{
    editor::{
        controller::font_family,
        highlight::{
            GUESS_CONTEXT, GUESS_DISTANCE, Highlighter, LOOKAHEAD, SLICE, Syntax, off_thread,
        },
        languages,
        state::Font,
    },
    syntax::Token,
};

/// Columns a tab takes.
const TAB: usize = 4;

/// One side's text: its lines, their highlighting, and how they are
/// numbered.
pub(crate) struct Side {
    pub(crate) text: String,
    rope: Rope,
    /// The start of every line.
    starts: Vec<usize>,
    pub(crate) highlighter: Option<Highlighter>,
    /// The widest line, in columns (tabs expanded).
    pub(crate) columns: usize,
    /// A patch's numbering: `(first line in the text, its number in the
    /// file)` of each hunk, in order. Empty: line `i` is number `i + 1`.
    numbers: Vec<(usize, usize)>,
    /// A patch's files' lines, each highlighted on its own (`files.rs`);
    /// empty: `highlighter` highlights the whole text.
    pub(crate) segments: Vec<Segment>,
}

impl Side {
    fn new(text: String, numbers: Vec<(usize, usize)>) -> Side {
        let starts = starts(&text);
        let mut columns = 0;
        for line in 0..starts.len() {
            columns = columns.max(display_columns(line_of(&text, &starts, line)));
        }
        Side {
            rope: Rope::from_str(&text),
            text,
            starts,
            highlighter: None,
            columns,
            numbers,
            segments: Vec::new(),
        }
    }

    /// How many lines it has (a final line break makes none).
    pub(crate) fn lines(&self) -> usize {
        self.starts.len()
    }

    /// Line `line`, without its line break.
    pub(crate) fn line(&self, line: usize) -> &str {
        line_of(&self.text, &self.starts, line)
    }

    /// The number line `line` shows (from 1, as in the file).
    pub(crate) fn number(&self, line: usize) -> usize {
        let at = self.numbers.partition_point(|(first, _)| *first <= line);
        match at.checked_sub(1).map(|i| self.numbers[i]) {
            Some((first, number)) => number + (line - first),
            None => line + 1,
        }
    }

    /// The largest number a line shows (numbers restart with each file of
    /// a patch).
    fn last_number(&self) -> usize {
        let mut last = self.number(self.lines());
        for pair in self.numbers.windows(2) {
            last = last.max(pair[0].1 + (pair[1].0 - pair[0].0));
        }
        last
    }

    /// The tokens of `line` (ranges within it), empty while it is not
    /// highlighted.
    fn tokens(&self, line: usize) -> Vec<(Range<usize>, Token)> {
        if !self.segments.is_empty() {
            return files::tokens(&self.segments, line);
        }
        self.highlighter
            .as_ref()
            .and_then(|h| h.tokens(line))
            .map(<[_]>::to_vec)
            .unwrap_or_default()
    }
}

/// What a side of a row shows.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RowCell {
    /// The line, `None` for the filler beside a line the other side lacks.
    pub(crate) line: Option<usize>,
    /// Its number in the file.
    pub(crate) number: Option<usize>,
    /// The row's kind on this side.
    pub(crate) kind: Tint,
    /// Its text in spans.
    pub(crate) spans: Vec<Span>,
}

/// How a cell is tinted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tint {
    Context,
    Added,
    Deleted,
    Filler,
}

/// A run of a line's text with one token and whether it changed within
/// the line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Span {
    pub(crate) text: String,
    pub(crate) token: Option<Token>,
    pub(crate) changed: bool,
}

/// The changed ranges within a paired old line and new line.
type Changed = (Vec<Range<usize>>, Vec<Range<usize>>);
/// A patch's numbering of each side (`Side::numbers`).
pub(crate) type Numbers = (Vec<(usize, usize)>, Vec<(usize, usize)>);

/// The view's state.
pub(crate) struct State {
    pub(crate) old: Side,
    pub(crate) new: Side,
    pub(crate) model: DiffModel,
    pub(crate) rows: Vec<Row>,
    pub(crate) expansions: Expansions,
    headers: Vec<Header>,
    /// Whether the texts are a patch's (only its hunks' lines).
    pub(crate) patch: bool,
    pub(crate) font: Font,
    /// The width of a column.
    pub(crate) column: Points,
    /// What highlights the texts' language (a patch's files: each
    /// segment's own).
    syntax: Syntax,
    /// The changed ranges of paired lines, by `(old, new)` line.
    inline: HashMap<(usize, usize), Changed>,
    /// The pairs of hunks' lines, by hunk (unified rows' words).
    pairs: HashMap<usize, Vec<Pair>>,
    /// Where the rows are (their wrapped lines, the annotations under
    /// them).
    pub(crate) geometry: Geometry,
    /// The rows are side by side.
    pub(crate) split: bool,
    /// The width of a side's text box (`softWrap` wraps in it).
    pub(crate) text_box: Points,
    /// Columns a line wraps at, `None` while lines do not wrap.
    pub(crate) wrap_columns: Option<usize>,
    /// Each row's wrapped lines.
    row_lines: Vec<u32>,
    /// The app's annotations.
    pub(crate) annotations: Vec<DiffAnnotation>,
    /// Where each annotation shows: its row and its top; `None` while its
    /// line is collapsed (or not in the texts).
    pub(crate) placed: Vec<Option<(usize, Points)>>,
    /// The annotations' heights as they laid out, by id.
    pub(crate) annotation_heights: HashMap<SharedString, Points>,
    /// A patch's files (none for two texts).
    pub(crate) files: Files,
}

impl State {
    fn new(font: Font) -> State {
        let column = crate::editor::controller::text_width(&font.css(), "0");
        State {
            old: Side::new(String::new(), Vec::new()),
            new: Side::new(String::new(), Vec::new()),
            model: DiffModel::compute("", ""),
            rows: Vec::new(),
            expansions: Expansions::default(),
            headers: Vec::new(),
            patch: false,
            font,
            column,
            syntax: Syntax::Plain,
            inline: HashMap::new(),
            pairs: HashMap::new(),
            geometry: Geometry::default(),
            split: true,
            text_box: Points::ZERO,
            wrap_columns: None,
            row_lines: Vec::new(),
            annotations: Vec::new(),
            placed: Vec::new(),
            annotation_heights: HashMap::new(),
            files: Files::default(),
        }
    }

    /// Diffs `old` and `new` again (`numbers`: a patch's numbering of each
    /// side, `headers` its hunks' headers).
    fn set_texts(&mut self, old: String, new: String, numbers: Numbers, headers: Vec<Header>) {
        self.model = DiffModel::compute(&old, &new);
        self.old = Side::new(old, numbers.0);
        self.new = Side::new(new, numbers.1);
        self.patch = !headers.is_empty();
        self.headers = headers;
        self.expansions.clear();
        self.inline.clear();
        self.pairs.clear();
        self.files.set(Vec::new());
        self.make_highlighters();
    }

    /// Shows a patch's files, joined.
    fn set_patch(&mut self, joined: Joined) {
        let Joined {
            old,
            new,
            numbers,
            model,
            segments,
            sections,
            ..
        } = joined;
        self.model = model;
        self.old = Side::new(old, numbers.0);
        self.new = Side::new(new, numbers.1);
        self.old.segments = segments.0;
        self.new.segments = segments.1;
        // Each file's hunk headers are its section's.
        self.headers = Vec::new();
        self.patch = true;
        self.expansions.clear();
        self.inline.clear();
        self.pairs.clear();
        self.files.set(sections);
        self.make_highlighters();
    }

    /// Whether a side has a language to highlight.
    fn highlighted(&self) -> bool {
        !self.syntax.is_plain()
            || files::hinted(&self.old.segments)
            || files::hinted(&self.new.segments)
    }

    /// Whether the highlighters can be made (the built-in syntaxes are
    /// loaded, where a side needs them).
    fn ready(&self) -> bool {
        self.syntax.ready() && files::ready(&self.old.segments) && files::ready(&self.new.segments)
    }

    fn make_highlighters(&mut self) {
        let ready = self.syntax.ready();
        for side in [&mut self.old, &mut self.new] {
            if side.segments.is_empty() {
                side.highlighter = ready.then(|| Highlighter::with(&self.syntax)).flatten();
            } else {
                side.highlighter = None;
                files::make_highlighters(&mut side.segments);
            }
        }
    }

    /// Lays the rows out again.
    fn relayout(&mut self, props: &DiffViewProps) {
        let options = Options {
            layout: match props.layout.get_untracked() {
                DiffLayout::Split => Layout::Split,
                DiffLayout::Unified => Layout::Unified,
            },
            context: props.context_lines.get_untracked() as usize,
            expand_all: props.expand_all.get_untracked(),
            headers: self.headers.clone(),
        };
        self.split = options.layout == Layout::Split;
        self.rows = if self.files.any() {
            let headers =
                self.files.count() > 1 || props.render_file_header.get_untracked().is_some();
            self.files.rows(options.layout, headers)
        } else {
            layout::rows(
                &self.model,
                &self.old.text,
                &self.new.text,
                &options,
                &self.expansions,
            )
        };
        self.wrap_columns =
            wrap_columns(props.soft_wrap.get_untracked(), self.text_box, self.column);
        self.measure_rows();
    }

    /// Counts each row's wrapped lines again, and places the rows.
    pub(crate) fn measure_rows(&mut self) {
        let columns = self.wrap_columns;
        // Without wrapping, or when every line fits, a row is a line.
        let fits = columns.is_none_or(|c| self.old.columns <= c && self.new.columns <= c);
        self.row_lines = if fits {
            vec![1; self.rows.len()]
        } else {
            let columns = columns.unwrap_or(usize::MAX);
            let count = |side: &Side, line: Option<usize>| {
                line.map_or(1, |l| {
                    geometry::wrapped_lines(&expand_tabs(side.line(l)), columns)
                })
            };
            self.rows
                .iter()
                .map(|row| match row {
                    Row::Line { old, new, .. } if self.split => {
                        count(&self.old, *old).max(count(&self.new, *new)) as u32
                    }
                    Row::Line { old, new, .. } => match new {
                        Some(_) => count(&self.new, *new) as u32,
                        None => count(&self.old, *old) as u32,
                    },
                    Row::Separator { .. } | Row::File { .. } => 1,
                })
                .collect()
        };
        self.place();
    }

    /// Places the rows and the annotations under them: a split row's
    /// annotations stack on their side and the row takes the taller
    /// stack; unified, they stack in order.
    pub(crate) fn place(&mut self) {
        let mut extra = vec![Points::ZERO; self.rows.len()];
        self.placed = vec![None; self.annotations.len()];
        if !self.annotations.is_empty() {
            // The row of every annotated line.
            let mut at: HashMap<(DiffSide, usize), usize> = self
                .annotations
                .iter()
                .map(|a| ((a.side, a.line as usize), usize::MAX))
                .collect();
            for (index, row) in self.rows.iter().enumerate() {
                if let Row::Line { old, new, .. } = row {
                    for key in [
                        old.map(|l| (DiffSide::Old, l)),
                        new.map(|l| (DiffSide::New, l)),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        if let Some(slot) = at.get_mut(&key) {
                            *slot = index;
                        }
                    }
                }
            }
            let mut stacks: HashMap<(usize, DiffSide), Points> = HashMap::new();
            for (index, annotation) in self.annotations.iter().enumerate() {
                let row = at[&(annotation.side, annotation.line as usize)];
                if row == usize::MAX {
                    continue;
                }
                let stack = if self.split {
                    annotation.side
                } else {
                    DiffSide::New
                };
                let below = stacks.entry((row, stack)).or_default();
                self.placed[index] = Some((row, *below));
                *below += self
                    .annotation_heights
                    .get(&annotation.id)
                    .copied()
                    .unwrap_or_default();
                extra[row] = extra[row].max(*below);
            }
        }
        self.geometry = Geometry::new(&self.row_lines, &extra, self.font.line_height);
        for (row, top) in self.placed.iter_mut().flatten() {
            *top += self.geometry.top(*row) + self.geometry.text_height(*row);
        }
    }

    /// The row showing line `line` of `side`, `None` while none does (it
    /// is collapsed).
    pub(crate) fn row_of(&self, side: DiffSide, line: usize) -> Option<usize> {
        self.rows
            .iter()
            .position(|row| line_at(row, side) == Some(line))
    }

    /// The cells of row `row`: the old side's and the new side's (split),
    /// or the one line it shows (unified, in `.1`, `.0` the filler).
    pub(crate) fn cells(&mut self, row: usize, inline: DiffInline) -> Option<(RowCell, RowCell)> {
        let Row::Line {
            old,
            new,
            kind,
            hunk,
        } = self.rows.get(row).cloned()?
        else {
            return None;
        };
        use layout::Kind;
        let (old_tint, new_tint) = match kind {
            Kind::Context => (Tint::Context, Tint::Context),
            Kind::Added => (Tint::Filler, Tint::Added),
            Kind::Deleted => (Tint::Deleted, Tint::Filler),
            Kind::Modified => (Tint::Deleted, Tint::Added),
        };
        let changed = match (old, new, kind) {
            (Some(o), Some(n), Kind::Modified) => self.inline_of(o, n, inline),
            // Unified rows show a pair's lines one over the other: the
            // words are those of the pair.
            (Some(o), None, Kind::Deleted) => match self.partner(hunk, Some(o), None) {
                Some(n) => self.inline_of(o, n, inline),
                None => Default::default(),
            },
            (None, Some(n), Kind::Added) => match self.partner(hunk, None, Some(n)) {
                Some(o) => self.inline_of(o, n, inline),
                None => Default::default(),
            },
            _ => Default::default(),
        };
        let old_cell = cell(&self.old, old, old_tint, &changed.0);
        let new_cell = cell(&self.new, new, new_tint, &changed.1);
        Some((old_cell, new_cell))
    }

    /// The line paired with old line `old` (or new line `new`) of hunk
    /// `hunk`: the other side's.
    fn partner(
        &mut self,
        hunk: Option<usize>,
        old: Option<usize>,
        new: Option<usize>,
    ) -> Option<usize> {
        let hunk = hunk?;
        let (old_text, new_text) = (&self.old.text, &self.new.text);
        let model = &self.model;
        let pairs = self
            .pairs
            .entry(hunk)
            .or_insert_with(|| model.pairs(hunk, old_text, new_text));
        pairs.iter().find_map(|pair| match (old, new) {
            (Some(o), _) if pair.old == Some(o) => pair.new,
            (_, Some(n)) if pair.new == Some(n) => pair.old,
            _ => None,
        })
    }

    fn inline_of(&mut self, old: usize, new: usize, inline: DiffInline) -> Changed {
        let mode = match inline {
            DiffInline::WordAlt => InlineMode::WordAlt,
            DiffInline::Word => InlineMode::Word,
            DiffInline::Char => InlineMode::Char,
            DiffInline::None => return Default::default(),
        };
        let (o, n) = (self.old.line(old), self.new.line(new));
        self.inline
            .entry((old, new))
            .or_insert_with(|| DiffModel::inline(o, n, mode))
            .clone()
    }

    /// The hunks, as the ref gives them.
    pub(crate) fn hunks(&self) -> Vec<DiffHunk> {
        let mut hunks = self
            .model
            .hunks
            .iter()
            .enumerate()
            .map(|(index, h)| DiffHunk {
                index: index as u32,
                old_start: h.old.start as u32,
                old_lines: h.old.len() as u32,
                new_start: h.new.start as u32,
                new_lines: h.new.len() as u32,
                ..Default::default()
            })
            .collect::<Vec<_>>();
        self.files.localize(&mut hunks);
        hunks
    }

    /// The width of a side's text box.
    pub(crate) fn text_width(&self, side: DiffSide) -> Points {
        let columns = match side {
            DiffSide::Old => self.old.columns,
            DiffSide::New => self.new.columns,
        };
        self.column * (columns + 2) as f32
    }

    /// The width of a number column.
    pub(crate) fn number_width(&self) -> Points {
        let last = self.old.last_number().max(self.new.last_number());
        let digits = (last.max(1).ilog10() as usize + 1).max(2);
        self.column * digits as f32
    }
}

/// The cell of `line` of `side`.
fn cell(side: &Side, line: Option<usize>, tint: Tint, changed: &[Range<usize>]) -> RowCell {
    let Some(line) = line else {
        return RowCell {
            line: None,
            number: None,
            kind: Tint::Filler,
            spans: Vec::new(),
        };
    };
    let text = side.line(line);
    RowCell {
        line: Some(line),
        number: Some(side.number(line)),
        kind: tint,
        spans: spans(text, &side.tokens(line), changed),
    }
}

/// `text` cut where its tokens or its changed ranges begin or end, tabs
/// expanded.
pub(crate) fn spans(
    text: &str,
    tokens: &[(Range<usize>, Token)],
    changed: &[Range<usize>],
) -> Vec<Span> {
    let mut cuts = vec![0, text.len()];
    for (range, _) in tokens {
        cuts.extend([range.start, range.end]);
    }
    for range in changed {
        cuts.extend([range.start, range.end]);
    }
    cuts.retain(|c| *c <= text.len() && text.is_char_boundary(*c));
    cuts.sort_unstable();
    cuts.dedup();
    let mut out: Vec<Span> = Vec::new();
    let mut column = 0;
    for pair in cuts.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let token = tokens
            .iter()
            .find(|(r, _)| r.start <= start && end <= r.end)
            .map(|(_, t)| *t);
        let is_changed = changed.iter().any(|r| r.start <= start && end <= r.end);
        let mut piece = String::with_capacity(end - start);
        for c in text[start..end].chars() {
            if c == '\t' {
                let n = TAB - column % TAB;
                piece.extend(std::iter::repeat_n(' ', n));
                column += n;
            } else {
                piece.push(c);
                column += 1;
            }
        }
        match out.last_mut() {
            Some(last) if last.token == token && last.changed == is_changed => {
                last.text.push_str(&piece)
            }
            _ => out.push(Span {
                text: piece,
                token,
                changed: is_changed,
            }),
        }
    }
    out
}

/// The start of every line of `text` (a final line break starts none).
fn starts(text: &str) -> Vec<usize> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0];
    out.extend(
        text.match_indices('\n')
            .map(|(i, _)| i + 1)
            .filter(|i| *i < text.len()),
    );
    out
}

fn line_of<'a>(text: &'a str, starts: &[usize], line: usize) -> &'a str {
    let Some(&start) = starts.get(line) else {
        return "";
    };
    let end = starts.get(line + 1).map_or(text.len(), |next| next - 1);
    let line = &text[start..end.max(start)];
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

/// The line of `side` row `row` shows, `None` for none (a separator, the
/// filler beside a line the other side lacks).
pub(crate) fn line_at(row: &Row, side: DiffSide) -> Option<usize> {
    match (row, side) {
        (Row::Line { old, .. }, DiffSide::Old) => *old,
        (Row::Line { new, .. }, DiffSide::New) => *new,
        _ => None,
    }
}

/// The columns lines wrap at in a text box of `width` (less the room
/// around the text), `None` without `softWrap` or before the box laid out.
pub(crate) fn wrap_columns(soft_wrap: bool, width: Points, column: Points) -> Option<usize> {
    let room = width - px(2.0 * super::view::PAD);
    if !soft_wrap || room <= Points::ZERO || column <= Points::ZERO {
        return None;
    }
    Some(((room / column).floor() as usize).max(1))
}

/// `line` with its tabs expanded, as its spans show it.
pub(crate) fn expand_tabs(line: &str) -> std::borrow::Cow<'_, str> {
    if !line.contains('\t') {
        return line.into();
    }
    let mut out = String::with_capacity(line.len() + TAB);
    let mut column = 0;
    for c in line.chars() {
        if c == '\t' {
            let n = TAB - column % TAB;
            out.extend(std::iter::repeat_n(' ', n));
            column += n;
        } else {
            out.push(c);
            column += 1;
        }
    }
    out.into()
}

fn display_columns(line: &str) -> usize {
    let mut column = 0;
    for c in line.chars() {
        column += if c == '\t' { TAB - column % TAB } else { 1 };
    }
    column
}

/// The diff view's controller: a clone shares everything.
#[derive(Clone)]
pub(crate) struct Dv {
    pub(crate) st: Rc<RefCell<State>>,
    pub(crate) props: DiffViewProps,
    cx: Scope<DiffViewEvent>,
    /// The rows changed (texts, layout, expansions).
    pub(crate) rev: Signal<u64>,
    /// Highlighting progressed.
    pub(crate) hl_rev: Signal<u64>,
    pub(crate) scroll_y: Signal<Points>,
    pub(crate) viewport: Signal<Size<Points>>,
    highlighting: Rc<Cell<bool>>,
    /// The stats reported last (`onStatsChange`).
    reported: Rc<Cell<Option<DiffStats>>>,
    pub(crate) vscroll: ElementRef,
    /// The rows moved without changing (wrapping, annotations' heights).
    pub(crate) geo: Signal<u64>,
    /// The lines selected on the line numbers.
    pub(crate) selection: Signal<Option<DiffLineRange>>,
    /// The press selecting lines, while it lasts.
    pub(crate) line_drag: Rc<Cell<Option<super::review::LineDrag>>>,
    /// Where a Shift-press extends the selection from: its side and line.
    pub(crate) anchor: Rc<Cell<Option<(DiffSide, usize)>>>,
    /// The row and side the pointer is over.
    pub(crate) hover: Signal<Option<(usize, DiffSide)>>,
    /// What the pointer is in, by row and part (gutter, text, the add
    /// control): it leaves one before or after it enters the next.
    pub(crate) hover_keys: Rc<RefCell<Vec<(usize, super::review::HoverPart)>>>,
    /// The sides' horizontal scroll views (split): old, new.
    pub(crate) hscroll: [ElementRef; 2],
    /// Where the sides scrolled to last, horizontally.
    pub(crate) hscroll_x: Rc<Cell<Points>>,
    /// The last navigation, while the view stays where it went.
    pub(crate) nav: Rc<Cell<Option<super::review::Nav>>>,
    /// The rows made last.
    rows_window: crate::window::RowWindow,
}

impl Dv {
    pub(crate) fn new(props: DiffViewProps, cx: Scope<DiffViewEvent>) -> Dv {
        let font = Font {
            family: font_family(props.font_family.get_untracked()),
            size: props.font_size.get_untracked(),
            line_height: props.line_height.get_untracked(),
        };
        let dv = Dv {
            st: Rc::new(RefCell::new(State::new(font))),
            props,
            cx,
            rev: signal(0),
            hl_rev: signal(0),
            scroll_y: signal(px(0.0)),
            viewport: signal(Size::default()),
            highlighting: Rc::new(Cell::new(false)),
            reported: Rc::default(),
            vscroll: element_ref(),
            geo: signal(0),
            selection: signal(None),
            line_drag: Rc::default(),
            anchor: Rc::default(),
            hover: signal(None),
            hover_keys: Rc::default(),
            hscroll: [element_ref(), element_ref()],
            hscroll_x: Rc::default(),
            nav: Rc::default(),
            rows_window: Default::default(),
        };
        dv.follow_props();
        dv
    }

    fn bump(&self) {
        self.rev.update(|r| *r += 1);
    }

    /// Reports `event`.
    pub(crate) fn emit(&self, event: DiffViewEvent) {
        self.cx.emit(event);
    }

    fn follow_props(&self) {
        let dv = self.clone();
        effect(move || {
            let font = Font {
                family: font_family(dv.props.font_family.get()),
                size: dv.props.font_size.get(),
                line_height: dv.props.line_height.get(),
            };
            {
                let mut st = dv.st.borrow_mut();
                st.column = crate::editor::controller::text_width(&font.css(), "0");
                st.font = font;
                let soft_wrap = dv.props.soft_wrap.get_untracked();
                st.wrap_columns = wrap_columns(soft_wrap, st.text_box, st.column);
                st.measure_rows();
            }
            dv.bump();
        });
        let dv = self.clone();
        effect(move || {
            let old = dv.props.old_value.get();
            let new = dv.props.new_value.get();
            let patch_text = dv.props.patch.get();
            let language = dv.props.language.get();
            {
                let mut st = dv.st.borrow_mut();
                match (old, new, patch_text) {
                    (None, None, Some(text)) => {
                        let joined = files::join(&text, language.as_ref().map(|l| l.as_str()));
                        let name = language.map(|l| l.to_string()).or(joined.path.clone());
                        st.syntax = languages::resolve(name.as_deref().unwrap_or("")).1;
                        st.set_patch(joined);
                    }
                    (old, new, _) => {
                        let name = language.map(|l| l.to_string());
                        st.syntax = languages::resolve(name.as_deref().unwrap_or("")).1;
                        st.set_texts(
                            old.map(|s| s.to_string()).unwrap_or_default(),
                            new.map(|s| s.to_string()).unwrap_or_default(),
                            Default::default(),
                            Vec::new(),
                        );
                    }
                }
                st.relayout(&dv.props);
            }
            dv.bump();
            untracked(|| dv.texts_changed());
            dv.report_stats();
            dv.load_syntaxes();
        });
        let dv = self.clone();
        effect(move || {
            dv.props.layout.get();
            dv.props.context_lines.get();
            dv.props.expand_all.get();
            dv.props.soft_wrap.get();
            dv.props.render_file_header.get();
            dv.st.borrow_mut().relayout(&dv.props);
            dv.bump();
        });
        let dv = self.clone();
        effect(move || {
            let annotations = dv.props.annotations.get();
            {
                let mut st = dv.st.borrow_mut();
                st.annotations = annotations;
                st.place();
            }
            dv.bump();
        });
    }

    /// The rows in view, and a few around them.
    pub(crate) fn visible_rows(&self) -> Range<usize> {
        self.geo.get();
        let st = self.st.borrow();
        let lh = st.font.line_height.max(px(1.0));
        let y = self.scroll_y.get().max(Points::ZERO);
        let height = self.viewport.get().height.max(lh * 40.0);
        let visible = st.geometry.range(y, height, 0);
        self.rows_window.rows(visible, st.geometry.rows())
    }

    // The ref.

    pub(crate) fn hunks(&self) -> Vec<DiffHunk> {
        self.st.borrow().hunks()
    }

    pub(crate) fn stats(&self) -> DiffStats {
        let st = self.st.borrow();
        let (added, deleted) = st.model.stats();
        DiffStats {
            added: added as u32,
            deleted: deleted as u32,
            hunks: st.model.hunks.len() as u32,
        }
    }

    /// Reports the stats when they changed.
    fn report_stats(&self) {
        let stats = self.stats();
        if self.reported.replace(Some(stats)) != Some(stats) {
            self.cx.emit(DiffViewEvent::StatsChange(stats));
        }
    }

    pub(crate) fn go_to_hunk(&self, index: usize) {
        let collapsed = self.st.borrow().files.collapsed_file_of_hunk(index);
        if let Some(path) = collapsed {
            self.set_file_collapsed(&path, Some(false));
        }
        let y = {
            let st = self.st.borrow();
            let Some(row) = layout::hunk_row(&st.rows, index) else {
                return;
            };
            st.geometry.top(row)
        };
        self.scroll_to_y(y, Some(index));
    }

    pub(crate) fn revert_hunk(&self, index: usize) {
        let change = {
            let st = self.st.borrow();
            let Some(hunk) = st.model.hunks.get(index) else {
                return;
            };
            DiffChange {
                old_value: st.old.text.clone(),
                new_value: model::revert_hunk(&st.old.text, &st.new.text, hunk),
            }
        };
        self.changed(change);
    }

    pub(crate) fn accept_hunk(&self, index: usize) {
        let change = {
            let st = self.st.borrow();
            let Some(hunk) = st.model.hunks.get(index) else {
                return;
            };
            DiffChange {
                old_value: model::accept_hunk(&st.old.text, &st.new.text, hunk),
                new_value: st.new.text.clone(),
            }
        };
        self.changed(change);
    }

    /// Shows `change`'s texts at once (the app sets them as the props
    /// after `onChange`, which changes nothing then) and reports them.
    fn changed(&self, change: DiffChange) {
        if self.st.borrow().patch {
            // A patch's texts are excerpts: there is nothing to revert in.
            return;
        }
        {
            let mut st = self.st.borrow_mut();
            st.set_texts(
                change.old_value.clone(),
                change.new_value.clone(),
                Default::default(),
                Vec::new(),
            );
            st.relayout(&self.props);
        }
        self.bump();
        self.load_syntaxes();
        self.cx.emit(DiffViewEvent::Change(change));
        self.texts_changed();
        self.report_stats();
    }

    pub(crate) fn expand(&self, gap: usize, direction: DiffExpand, lines: usize) {
        {
            let mut st = self.st.borrow_mut();
            match direction {
                DiffExpand::All => st.expansions.expand_gap(gap),
                DiffExpand::Up => st.expansions.expand(gap, true, lines),
                DiffExpand::Down => st.expansions.expand(gap, false, lines),
            }
            st.relayout(&self.props);
        }
        self.bump();
        self.schedule_highlight();
    }

    pub(crate) fn expand_everything(&self) {
        {
            let mut st = self.st.borrow_mut();
            let gaps = st.model.hunks.len() + 1;
            for gap in 0..gaps {
                st.expansions.expand_gap(gap);
            }
            st.relayout(&self.props);
        }
        self.bump();
        self.schedule_highlight();
    }

    pub(crate) fn collapse_all(&self) {
        {
            let mut st = self.st.borrow_mut();
            st.expansions.clear();
            st.relayout(&self.props);
        }
        self.bump();
    }

    // Files.

    pub(crate) fn files(&self) -> Vec<DiffFile> {
        self.st.borrow().files.list()
    }

    /// Collapses, expands or toggles (`None`) the file at `path`, and
    /// reports it when that changed it.
    pub(crate) fn set_file_collapsed(&self, path: &str, collapsed: Option<bool>) {
        let file = {
            let mut st = self.st.borrow_mut();
            let Some(file) = st.files.set_collapsed(path, collapsed) else {
                return;
            };
            st.relayout(&self.props);
            file
        };
        self.bump();
        self.schedule_highlight();
        self.cx.emit(DiffViewEvent::FileToggle(file));
    }

    pub(crate) fn scroll_to_file(&self, path: &str) {
        let y = {
            let st = self.st.borrow();
            let Some(row) = st
                .files
                .index(path)
                .and_then(|index| files::file_row(&st.rows, index))
            else {
                return;
            };
            st.font.line_height * row as f32
        };
        self.vscroll.scroll_to(point(px(0.0), y), true);
    }

    // Highlighting.

    fn load_syntaxes(&self) {
        if !self.st.borrow().highlighted() {
            return;
        }
        if self.st.borrow().ready() {
            self.st.borrow_mut().make_highlighters();
            self.schedule_highlight();
            return;
        }
        let dv = self.clone();
        spawn(async move {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let _ = blocking(Highlighter::load).await;
            }
            #[cfg(target_arch = "wasm32")]
            {
                next_frame().await;
                Highlighter::load();
            }
            dv.st.borrow_mut().make_highlighters();
            dv.schedule_highlight();
        });
    }

    /// Highlights both sides up to the last lines in view (and on past
    /// them), off the engine thread; lines in view far past the parse are
    /// guessed first.
    pub(crate) fn schedule_highlight(&self) {
        if self.highlighting.replace(true) {
            return;
        }
        let dv = self.clone();
        spawn(async move {
            loop {
                let work = {
                    let rows = untracked(|| dv.visible_rows());
                    let mut st = dv.st.borrow_mut();
                    let st = &mut *st;
                    // The first and last line of each side in view.
                    let (mut old_lines, mut new_lines) = ((usize::MAX, 0), (usize::MAX, 0));
                    for row in &st.rows[rows.start.min(st.rows.len())..rows.end.min(st.rows.len())]
                    {
                        if let Row::Line { old, new, .. } = row {
                            for (line, lines) in [(old, &mut old_lines), (new, &mut new_lines)] {
                                if let Some(line) = *line {
                                    lines.0 = lines.0.min(line);
                                    lines.1 = lines.1.max(line);
                                }
                            }
                        }
                    }
                    // By side and, for a patch's files, segment.
                    let mut work = Vec::new();
                    for (index, (side, lines)) in
                        [(&mut st.old, old_lines), (&mut st.new, new_lines)]
                            .into_iter()
                            .enumerate()
                    {
                        if !side.segments.is_empty() {
                            // No line of this side in view: nothing to do.
                            if lines.0 <= lines.1 {
                                for (segment, guess, job) in
                                    files::work(&mut side.segments, lines.0..lines.1 + 1)
                                {
                                    work.push((index, Some(segment), guess, job));
                                }
                            }
                            continue;
                        }
                        let last = lines.1;
                        let first = lines.0.min(last);
                        let start = first.saturating_sub(GUESS_CONTEXT);
                        let start_offset = side.starts.get(start).copied().unwrap_or(0);
                        if let Some(h) = &mut side.highlighter {
                            let guess = (first > h.frontier().saturating_add(GUESS_DISTANCE))
                                .then(|| h.guess(&side.rope, start, start_offset, last))
                                .flatten();
                            let job = h.job(&side.rope, last + LOOKAHEAD, SLICE);
                            if guess.is_some() || job.is_some() {
                                work.push((index, None, guess, job));
                            }
                        }
                    }
                    work
                };
                if work.is_empty() {
                    break;
                }
                let done = off_thread(move || {
                    work.into_iter()
                        .map(|(index, segment, guess, job)| {
                            (index, segment, guess.map(|g| g.run()), job.map(|j| j.run()))
                        })
                        .collect::<Vec<_>>()
                })
                .await;
                let mut changed = false;
                {
                    let mut st = dv.st.borrow_mut();
                    let st = &mut *st;
                    for (index, segment, guessed, done) in done {
                        let side = if index == 0 { &mut st.old } else { &mut st.new };
                        if let Some(segment) = segment {
                            changed |= files::finish(&mut side.segments, segment, guessed, done);
                            continue;
                        }
                        // A highlighter made since for other texts drops
                        // what was made for the one before.
                        let Some(h) = &mut side.highlighter else {
                            continue;
                        };
                        if let Some(guessed) = guessed {
                            changed |= !h.guessed(guessed).is_empty();
                        }
                        if let Some(done) = done {
                            changed |= !h.finish(done).0.is_empty();
                        }
                    }
                }
                if changed {
                    dv.hl_rev.update(|r| *r += 1);
                }
                #[cfg(target_arch = "wasm32")]
                next_frame().await;
            }
            dv.highlighting.set(false);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_and_spans() {
        let text = "a\n\tb\n";
        let starts = starts(text);
        assert_eq!(starts, vec![0, 2]);
        assert_eq!(line_of(text, &starts, 1), "\tb");
        assert_eq!(display_columns("\tb"), 5);
        let changed = vec![Range { start: 1, end: 2 }];
        let spans = spans("ab\tc", &[], &changed);
        let texts: Vec<_> = spans.iter().map(|s| (s.text.as_str(), s.changed)).collect();
        assert_eq!(texts, vec![("a", false), ("b", true), ("  c", false)]);
    }

    #[test]
    fn numbers_follow_a_patch() {
        let side = Side::new("a\nb\nc\n".to_string(), vec![(0, 10), (2, 40)]);
        assert_eq!(side.number(0), 10);
        assert_eq!(side.number(1), 11);
        assert_eq!(side.number(2), 40);
        let plain = Side::new("a\nb".to_string(), Vec::new());
        assert_eq!(plain.lines(), 2);
        assert_eq!(plain.number(1), 2);
    }
}
