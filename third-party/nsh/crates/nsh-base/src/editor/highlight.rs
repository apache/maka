//! The editor's syntax highlighting pipeline, as the text changes: one
//! path for every highlighter, the built-in one (syntect, line by line,
//! feature `highlight`) and the app's ([`EditorHighlighter`]).
//!
//! The tokens stay here, on the engine thread, by line; the highlighter
//! goes off it in a [`Job`] (a snapshot of the text, a budget) and comes
//! back with the lines it highlighted. An edit tells the highlighter what
//! changed and moves the tokens with the text, keeping the colors of an
//! edited line (`LineEdit`) until the highlighter gives it new ones, so
//! colors do not flicker. Edits made while a job is out are kept and
//! given to the highlighter when it comes back; the lines it highlighted
//! from the text before them move with them. Lines in view far past the
//! highlighting from the start are guessed ([`Guess`]) by a highlighter
//! made for that, when the language's highlighter guesses.
//!
//! The built-in highlighter keeps syntect's state at the start of every
//! line parsed, so an edit costs only the lines it touched: parsing starts
//! again at the first line the edit changed, from the state kept there,
//! and stops as soon as a line ends in the state the next line started
//! with before (its tokens and every later line's are what they were).
//! Only an edit that changes what follows (opening a block comment or a
//! string) parses on.
//!
//! The tokens and their colors are `crate::syntax`'s, shared with
//! `TextView`'s code blocks.

use std::{fmt, ops::Range, rc::Rc, time::Duration};

use ropey::Rope;

use super::{
    buffer::{Buffer, Change, LineSpan},
    highlighter::{EditorHighlighter, EditorText, EditorTextEdit, EditorTextPoint, EditorTokens},
};
use crate::syntax::Token;

/// A line's tokens: byte ranges within the line, sorted, apart.
pub(crate) type Tokens = Vec<(Range<usize>, Token)>;

/// One replacement in an edited span of lines, for keeping the colors of
/// what it left until the lines are parsed again: from byte `start` of the
/// span's first line to the `rest` last bytes of its last line became new
/// text, which ends at byte `tail` of the new span's last line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LineEdit {
    pub(crate) start: usize,
    pub(crate) tail: usize,
    pub(crate) rest: usize,
    /// The old line's length when the span was one line (else the tokens
    /// tell).
    pub(crate) old_len: Option<usize>,
}

/// How long a [`Job`] parses before the view shows what it found: on a
/// blocking thread where there are threads, else within a frame.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const SLICE: Duration = Duration::from_millis(25);
/// How long a [`Job`] parses before the view shows what it found: on a
/// blocking thread where there are threads, else within a frame.
#[cfg(target_arch = "wasm32")]
pub(crate) const SLICE: Duration = Duration::from_millis(4);

/// The lines in view are guessed ([`Highlighter::guess`]) when they are
/// at least this far past the parse from the text's start: further than a
/// slice or two parses.
pub(crate) const GUESS_DISTANCE: usize = 500;

/// How many lines before the first one in view a guess starts at (from a
/// fresh state): enough for most constructs that span lines to open again
/// before the lines shown.
pub(crate) const GUESS_CONTEXT: usize = 40;

/// How far past the last line in view the parse goes on (off the engine
/// thread, so scrolling down finds the lines highlighted).
pub(crate) const LOOKAHEAD: usize = 1000;

/// Runs `f` on a blocking thread where there are threads (WebAssembly has
/// none: there it runs at once).
pub(crate) async fn off_thread<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    #[cfg(not(target_arch = "wasm32"))]
    {
        match nsh_core::prelude::blocking(f).await {
            Ok(r) => r,
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }
    #[cfg(target_arch = "wasm32")]
    {
        f()
    }
}

/// Makes the highlighters of an app's language ([`super::register_highlighter`]).
pub(crate) type Factory = Rc<dyn Fn() -> Box<dyn EditorHighlighter>>;

/// What highlights a language: nothing, the built-in highlighter with a
/// syntax hint (an extension or a name syntect knows), or the app's.
#[derive(Clone, Default)]
pub(crate) enum Syntax {
    #[default]
    Plain,
    Builtin(&'static str),
    App(Factory),
}

impl fmt::Debug for Syntax {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Syntax::Plain => f.write_str("Plain"),
            Syntax::Builtin(hint) => f.debug_tuple("Builtin").field(hint).finish(),
            Syntax::App(_) => f.write_str("App"),
        }
    }
}

impl Syntax {
    /// The built-in highlighter with `hint` (plain for an empty one).
    pub(crate) fn builtin(hint: &'static str) -> Syntax {
        match hint.is_empty() {
            true => Syntax::Plain,
            false => Syntax::Builtin(hint),
        }
    }

    /// Nothing highlights the text.
    pub(crate) fn is_plain(&self) -> bool {
        matches!(self, Syntax::Plain)
    }

    /// Whether a highlighter can be made now: the built-in one needs its
    /// syntaxes loaded first ([`Highlighter::load`], off the engine thread).
    pub(crate) fn ready(&self) -> bool {
        match self {
            Syntax::Builtin(_) => Highlighter::ready(),
            _ => true,
        }
    }

    /// The same highlighting: the same hint, or the same factory.
    pub(crate) fn same(&self, other: &Syntax) -> bool {
        match (self, other) {
            (Syntax::Plain, Syntax::Plain) => true,
            (Syntax::Builtin(a), Syntax::Builtin(b)) => a == b,
            (Syntax::App(a), Syntax::App(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// A new highlighter; None for plain text and a language the built-in
    /// highlighter lacks.
    fn make(&self) -> Option<Box<dyn EditorHighlighter>> {
        match self {
            Syntax::Plain => None,
            #[cfg(feature = "highlight")]
            Syntax::Builtin(hint) => {
                syntect_lines::Syntect::new(hint).map(|h| Box::new(h) as Box<dyn EditorHighlighter>)
            }
            #[cfg(not(feature = "highlight"))]
            Syntax::Builtin(_) => None,
            Syntax::App(make) => Some(make()),
        }
    }
}

/// A line's tokens as the view gets them.
struct Known {
    tokens: Tokens,
    /// Parsed from a fresh state near the view, not from the text's
    /// start ([`Highlighter::guess`]), or kept over an edit: shown until
    /// the highlighting from the start gives the line its own.
    guessed: bool,
}

/// Highlights a text as it changes: the tokens (on the engine thread, for
/// the view) and the highlighter (which highlights on, here or on a
/// blocking thread).
pub(crate) struct Highlighter {
    /// Tells its jobs' and guesses' work from another highlighter's
    /// (one made since for other texts or another language).
    id: u64,
    /// What makes the highlighters of the guesses.
    syntax: Syntax,
    tokens: Vec<Option<Known>>,
    /// `None` while a [`Job`] has it.
    parser: Option<Box<dyn EditorHighlighter>>,
    /// The edits made while a job had the parser, in order: given to it
    /// when it comes back.
    pending: Vec<EditorTextEdit>,
    /// How far the parser had come, as last known.
    frontier: usize,
    /// The lines up to this one are current (the last job's last line,
    /// when it finished them and nothing changed since).
    current_to: Option<usize>,
    /// The text as last told, for the places of an edit's old end, and its
    /// lines.
    text: Rope,
    text_lines: usize,
    /// The language's highlighter guesses: false once a guess said it
    /// does not.
    guesses: bool,
    /// How many lines jobs highlighted, for the tests of what an edit
    /// costs.
    #[cfg(test)]
    parses: usize,
}

/// Highlighting on from where a [`Highlighter`] stopped, which may run on
/// another thread ([`Job::run`]) while the highlighter keeps showing the
/// tokens it has.
pub(crate) struct Job {
    id: u64,
    parser: Box<dyn EditorHighlighter>,
    text: EditorText,
    last_line: usize,
    budget: Duration,
}

/// What a [`Job`] did, for [`Highlighter::finish`].
pub(crate) struct Done {
    id: u64,
    parser: Box<dyn EditorHighlighter>,
    tokens: EditorTokens,
    last_line: usize,
    /// The lines up to `last_line` are current.
    current: bool,
}

/// Highlighting the lines in view from a fresh state, ahead of the
/// highlighting from the text's start ([`Highlighter::guess`]).
pub(crate) struct Guess {
    id: u64,
    parser: Box<dyn EditorHighlighter>,
    text: EditorText,
    first: usize,
    offset: usize,
    last: usize,
}

/// What a [`Guess`] found: the tokens of its lines.
pub(crate) struct Guessed {
    id: u64,
    tokens: EditorTokens,
    /// The highlighter guesses (false: it found nothing, and the
    /// language's highlighters are not asked again).
    guessed: bool,
}

impl Highlighter {
    /// The built-in highlighter for syntax hint `hint` (an extension or a
    /// name syntect knows); None for plain text and a language syntect
    /// lacks. Loads the syntaxes when they are not loaded yet
    /// ([`Self::ready`]).
    pub(crate) fn new(hint: &'static str) -> Option<Highlighter> {
        Self::with(&Syntax::builtin(hint))
    }

    /// The highlighter of `syntax`; None for plain text and a language the
    /// built-in highlighter lacks.
    pub(crate) fn with(syntax: &Syntax) -> Option<Highlighter> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let parser = syntax.make()?;
        Some(Highlighter {
            id: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            syntax: syntax.clone(),
            tokens: Vec::new(),
            frontier: parser.frontier(),
            parser: Some(parser),
            pending: Vec::new(),
            current_to: None,
            text: Rope::new(),
            text_lines: 1,
            guesses: true,
            #[cfg(test)]
            parses: 0,
        })
    }

    /// Whether the built-in syntaxes are loaded (loading takes tens of
    /// ms: the view loads them on a blocking thread first).
    pub(crate) fn ready() -> bool {
        #[cfg(feature = "highlight")]
        {
            crate::syntax::loaded()
        }
        #[cfg(not(feature = "highlight"))]
        {
            true
        }
    }

    /// Loads the built-in syntaxes (blocking; call off the engine thread).
    pub(crate) fn load() {
        #[cfg(feature = "highlight")]
        crate::syntax::syntaxes();
    }

    /// The text became `buffer`'s by `changes` (the buffer's last change
    /// list), over lines `span`: the highlighter is told, the tokens of
    /// the lines after the span shift (and stay until highlighted again,
    /// so the colors do not flicker), and `keep` (the one change's, on the
    /// span's lines) keeps what it left of the span's old tokens, moved
    /// where that text is now, the typed text in the token it continues.
    pub(crate) fn edited(
        &mut self,
        buffer: &Buffer,
        span: LineSpan,
        changes: &[Change],
        keep: Option<LineEdit>,
    ) {
        let edit = text_edit(
            &self.text,
            self.text_lines,
            buffer,
            span,
            changes,
            self.places(),
        );
        self.told(buffer);
        self.edited_keeping(edit, keep);
    }

    /// Everything changed (a new text, a new highlighter): highlights the
    /// text of `buffer` again, from the start.
    pub(crate) fn reset(&mut self, buffer: &Buffer) {
        let lines = buffer.line_count();
        let mut edit = EditorTextEdit {
            first_line: 0,
            old_line_count: lines,
            new_line_count: lines,
            start_byte: 0,
            old_end_byte: self.text.len_bytes(),
            new_end_byte: buffer.len(),
            ..EditorTextEdit::default()
        };
        if self.places() {
            let old_len = self.text.len_bytes();
            edit.old_end = EditorTextPoint::new(
                self.text_lines - 1,
                old_len - line_start_before(&self.text, old_len),
            );
            edit.new_end = EditorTextPoint::new(lines - 1, buffer.line_len(lines - 1));
        }
        self.told(buffer);
        self.edited_keeping(edit, None);
    }

    /// Lines `first..first + old_count` became `first..first + new_count`
    /// (an edit of lines only, as the tests of the built-in highlighter
    /// make them).
    #[cfg(test)]
    pub(crate) fn edited_lines(&mut self, first: usize, old_count: usize, new_count: usize) {
        self.edited_keeping(EditorTextEdit::lines(first, old_count, new_count), None);
    }

    /// The text now is `buffer`'s: what the places of the next edit's old
    /// end are found in.
    fn told(&mut self, buffer: &Buffer) {
        if self.places() {
            self.text = buffer.rope().clone();
            self.text_lines = buffer.line_count();
        }
    }

    /// Edits carry places (lines and columns): only an app's highlighter
    /// reads them (tree-sitter's edits do); finding them costs a scan of
    /// the edited line.
    fn places(&self) -> bool {
        matches!(self.syntax, Syntax::App(_))
    }

    fn edited_keeping(&mut self, edit: EditorTextEdit, line_edit: Option<LineEdit>) {
        let EditorTextEdit {
            first_line: first,
            old_line_count: old_count,
            new_line_count: new_count,
            ..
        } = edit;
        let kept = line_edit.and_then(|line_edit| {
            let known = |line: usize| self.tokens.get(line)?.as_ref().map(|k| k.tokens.clone());
            let old_first = known(first)?;
            let old_last = if old_count == 1 {
                old_first.clone()
            } else {
                known(first + old_count - 1)?
            };
            Some(keep(&old_first, &old_last, line_edit, new_count == 1))
        });
        splice(&mut self.tokens, first, old_count, new_count, || None);
        if let Some(slot) = self.tokens.get_mut(first) {
            *slot = None;
        }
        self.frontier = self.frontier.min(first);
        self.current_to = None;
        match &mut self.parser {
            Some(parser) => parser.edited(&edit),
            None => self.pending.push(edit),
        }
        if let Some((head, last)) = kept {
            let keep = |tokens| {
                Some(Known {
                    tokens,
                    guessed: true,
                })
            };
            if let Some(slot) = self.tokens.get_mut(first) {
                *slot = keep(head);
            }
            if let (Some(last), Some(slot)) = (last, self.tokens.get_mut(first + new_count - 1)) {
                *slot = keep(last);
            }
        }
    }

    /// Highlights the lines not current in order up to `last_line`
    /// (inclusive), within `budget` (at least one line per call), here.
    /// Returns the lines whose tokens changed and whether all lines up to
    /// `last_line` are current.
    #[cfg(test)]
    pub(crate) fn highlight(
        &mut self,
        rope: &Rope,
        last_line: usize,
        budget: Duration,
    ) -> (Range<usize>, bool) {
        match self.job(rope, last_line, budget) {
            Some(job) => self.finish(job.run()),
            None => (
                self.frontier..self.frontier,
                self.current_to.is_some_and(|l| l >= last_line),
            ),
        }
    }

    /// The highlighting up to `last_line` within `budget`, to run anywhere
    /// ([`Job::run`]) and hand back ([`Self::finish`]); None when the
    /// lines up to `last_line` are current, or a job is running.
    pub(crate) fn job(&mut self, rope: &Rope, last_line: usize, budget: Duration) -> Option<Job> {
        if self.parser.is_none() || self.current_to.is_some_and(|l| l >= last_line) {
            return None;
        }
        Some(Job {
            id: self.id,
            parser: self.parser.take()?,
            text: EditorText::new(rope.clone()),
            last_line,
            budget,
        })
    }

    /// A job's work: its tokens shown (the lines it highlighted moved with
    /// the edits made meanwhile, those the edits replaced dropped), its
    /// highlighter back, the edits given to it. Returns the lines whose
    /// tokens changed and whether the lines up to the job's last one are
    /// current.
    pub(crate) fn finish(&mut self, done: Done) -> (Range<usize>, bool) {
        if done.id != self.id {
            return (0..0, false);
        }
        let Done {
            mut parser,
            tokens,
            last_line,
            current,
            ..
        } = done;
        #[cfg(test)]
        {
            self.parses += tokens.lines.len();
        }
        let mut changed: Option<Range<usize>> = None;
        'lines: for (line, tokens) in tokens.lines {
            let mut line = line;
            for edit in &self.pending {
                if line < edit.first_line {
                    continue;
                }
                if line < edit.first_line + edit.old_line_count {
                    // Its text was replaced: the highlighter gives it
                    // again.
                    continue 'lines;
                }
                line = line - edit.old_line_count + edit.new_line_count;
            }
            if self.tokens.len() <= line {
                self.tokens.resize_with(line + 1, || None);
            }
            let slot = &mut self.tokens[line];
            if slot
                .as_ref()
                .is_some_and(|k| !k.guessed && k.tokens == tokens)
            {
                continue;
            }
            *slot = Some(Known {
                tokens,
                guessed: false,
            });
            changed = Some(match changed {
                Some(range) => range.start.min(line)..range.end.max(line + 1),
                None => line..line + 1,
            });
        }
        let edited = !self.pending.is_empty();
        for edit in self.pending.drain(..) {
            parser.edited(&edit);
        }
        self.frontier = parser.frontier();
        self.current_to = (current && !edited).then_some(last_line);
        self.parser = Some(parser);
        (
            changed.unwrap_or(self.frontier..self.frontier),
            current && !edited,
        )
    }

    /// How far the highlighting from the text's start has come: the lines
    /// before this one are current.
    pub(crate) fn frontier(&self) -> usize {
        self.frontier
    }

    /// The lines `first..=last` highlighted from a fresh state, starting
    /// at byte `offset` (line `first`'s start), for lines far past the
    /// highlighting from the start to show colors at once; None when every
    /// line from `first + GUESS_CONTEXT` to `last` has tokens, or the
    /// language's highlighter does not guess.
    pub(crate) fn guess(
        &self,
        rope: &Rope,
        first: usize,
        offset: usize,
        last: usize,
    ) -> Option<Guess> {
        if !self.guesses {
            return None;
        }
        let shown = (first + GUESS_CONTEXT).min(last)..last + 1;
        if shown
            .clone()
            .all(|line| self.tokens.get(line).is_some_and(Option::is_some))
        {
            return None;
        }
        Some(Guess {
            id: self.id,
            parser: self.syntax.make()?,
            text: EditorText::new(rope.clone()),
            first,
            offset,
            last,
        })
    }

    /// Shows a guess's tokens on the lines the highlighting from the start
    /// has not reached (a guess made before an edit is dropped by the
    /// caller). Returns the lines whose tokens changed.
    pub(crate) fn guessed(&mut self, guessed: Guessed) -> Range<usize> {
        if guessed.id != self.id {
            return 0..0;
        }
        if !guessed.guessed {
            self.guesses = false;
            return 0..0;
        }
        let mut changed: Option<Range<usize>> = None;
        for (line, tokens) in guessed.tokens.lines {
            if self.tokens.len() <= line {
                self.tokens.resize_with(line + 1, || None);
            }
            let slot = &mut self.tokens[line];
            if slot.as_ref().is_some_and(|k| !k.guessed) {
                continue;
            }
            *slot = Some(Known {
                tokens,
                guessed: true,
            });
            changed = Some(match changed {
                Some(range) => range.start.min(line)..range.end.max(line + 1),
                None => line..line + 1,
            });
        }
        changed.unwrap_or(0..0)
    }

    /// The tokens of `line`: byte ranges within the line (without its
    /// '\n'), sorted, not overlapping. None while the line is not
    /// highlighted yet; a line an edit has not reached yet keeps the
    /// tokens it had.
    pub(crate) fn tokens(&self, line: usize) -> Option<&[(Range<usize>, Token)]> {
        self.tokens.get(line)?.as_ref().map(|k| k.tokens.as_slice())
    }

    #[cfg(all(test, feature = "highlight"))]
    fn parses(&mut self) -> &mut usize {
        &mut self.parses
    }
}

impl Job {
    /// Highlights (blocking: on a blocking thread where there are some).
    pub(crate) fn run(mut self) -> Done {
        let mut tokens = EditorTokens::default();
        let current = self
            .parser
            .highlight(&self.text, self.last_line, self.budget, &mut tokens);
        Done {
            id: self.id,
            parser: self.parser,
            tokens,
            last_line: self.last_line,
            current,
        }
    }
}

impl Guess {
    /// Highlights its lines (blocking).
    pub(crate) fn run(mut self) -> Guessed {
        let mut tokens = EditorTokens::default();
        let guessed =
            self.parser
                .guess(&self.text, self.first, self.offset, self.last, &mut tokens);
        Guessed {
            id: self.id,
            tokens,
            guessed,
        }
    }
}

/// What a highlighter is told of `changes` over lines `span` (from `old`,
/// of `old_lines` lines, to `buffer`'s text): one change as it is, several
/// as one over the lines they touched; with `places`, the lines and
/// columns of its ends too.
fn text_edit(
    old: &Rope,
    old_lines: usize,
    buffer: &Buffer,
    span: LineSpan,
    changes: &[Change],
    places: bool,
) -> EditorTextEdit {
    let first = span.first;
    let last = first + span.new_count.max(1) - 1;
    let line_start = buffer.line_start(first);
    let (start_byte, old_end_byte, new_end_byte) = match changes {
        [change] => (
            change.range.start,
            change.range.end,
            change.range.start + change.new_len,
        ),
        _ => {
            let new_end = buffer.line_start(last) + buffer.line_len(last);
            // What follows the span is the same text before and after.
            let old_end = (old.len_bytes() + new_end).saturating_sub(buffer.len());
            (line_start, old_end, new_end)
        }
    };
    let mut edit = EditorTextEdit {
        first_line: first,
        old_line_count: span.old_count,
        new_line_count: span.new_count,
        start_byte,
        old_end_byte,
        new_end_byte,
        ..EditorTextEdit::default()
    };
    if places {
        let start = EditorTextPoint::new(first, start_byte.saturating_sub(line_start));
        let old_last = first + span.old_count.max(1) - 1;
        let old_column = match span.old_count <= 1 {
            true => start.column + old_end_byte.saturating_sub(start_byte),
            false if old_end_byte <= old.len_bytes() => {
                old_end_byte - line_start_before(old, old_end_byte)
            }
            // The highlighter missed a text: no place to find.
            false => 0,
        };
        edit.start = start;
        edit.old_end = EditorTextPoint::new(old_last.min(old_lines.max(1) - 1), old_column);
        edit.new_end =
            EditorTextPoint::new(last, new_end_byte.saturating_sub(buffer.line_start(last)));
    }
    edit
}

/// Where the line holding byte `byte` of `rope` starts (after the line
/// break before it).
fn line_start_before(rope: &Rope, byte: usize) -> usize {
    let mut bytes = rope.bytes_at(byte);
    let mut at = byte;
    while let Some(b) = bytes.prev() {
        if b == b'\n' {
            break;
        }
        at -= 1;
    }
    at
}

/// The tokens `edit` leaves of a span's first and last lines' old
/// tokens: the new first line's and, when the span has several lines
/// now (not `one_line`), the new last line's. The typed text joins the
/// token it continues: the one before it, else the one after.
fn keep(
    old_first: &Tokens,
    old_last: &Tokens,
    edit: LineEdit,
    one_line: bool,
) -> (Tokens, Option<Tokens>) {
    let LineEdit {
        start,
        tail,
        rest,
        old_len,
    } = edit;
    let mut head: Tokens = old_first
        .iter()
        .filter(|(r, _)| r.start < start)
        .map(|(r, t)| (r.start..r.end.min(start), *t))
        .collect();
    let old_len = old_len.unwrap_or_else(|| old_last.last().map_or(0, |(r, _)| r.end));
    let cut = old_len.saturating_sub(rest);
    let mut after: Tokens = old_last
        .iter()
        .filter(|(r, _)| r.end > cut)
        .map(|(r, t)| (r.start.max(cut) - cut + tail..r.end - cut + tail, *t))
        .collect();
    if !one_line {
        return (head, Some(after));
    }
    match head.last_mut() {
        Some((r, _)) if r.end == start => r.end = tail,
        _ => {
            if let Some((r, _)) = after.first_mut().filter(|(r, _)| r.start == tail) {
                r.start = start;
            }
        }
    }
    let end = head.last().map_or(0, |(r, _)| r.end);
    head.extend(after.into_iter().filter_map(|(r, t)| {
        let r = r.start.max(end)..r.end;
        (!r.is_empty()).then_some((r, t))
    }));
    (head, None)
}

/// Replaces `first..first + old_count` of `items` with `new_count` new
/// ones; past the end, cuts `items` at `first`.
fn splice<T>(
    items: &mut Vec<T>,
    first: usize,
    old_count: usize,
    new_count: usize,
    new: impl FnMut() -> T,
) {
    if first >= items.len() {
        return;
    }
    let end = first + old_count;
    if end <= items.len() {
        items.splice(first..end, std::iter::repeat_with(new).take(new_count));
    } else {
        items.truncate(first);
    }
}

#[cfg(feature = "highlight")]
mod syntect_lines {
    use std::time::Duration;

    use nsh_core::time::Instant;
    use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};

    use super::{EditorHighlighter, EditorText, EditorTextEdit, EditorTokens, Tokens, splice};
    use crate::syntax::{find_syntax, scope_token, syntaxes};

    /// The parser and the scopes open at a line's start.
    type State = (ParseState, ScopeStack);

    /// The parser keeps its state at the start of every this many lines
    /// (and of the lines it kept one for before an edit shifted them): a
    /// state per line would cost about a kilobyte a line, and starting a
    /// parse up to this many lines early costs next to nothing.
    pub(super) const CHECKPOINT: usize = 16;

    /// What the parser knows of one line.
    #[derive(Default)]
    struct Line {
        /// The state at the line's start, kept for checkpoints: what
        /// parsing starts again from, and what tells whether a parse that
        /// reaches the line converged.
        start: Option<State>,
        /// Its tokens are current (parsed since the line last changed).
        done: bool,
        /// Its bytes with its line break, as last parsed.
        len: usize,
    }

    /// The built-in highlighter: syntect, line by line, from the states
    /// it kept.
    pub(crate) struct Syntect {
        syntax: &'static SyntaxReference,
        /// The lines from the first one, as far as they have been parsed
        /// (one past the last line parsed, unless that was the last line
        /// of the text).
        lines: Vec<Line>,
        /// The lines before this one are current.
        parsed: usize,
        /// Where line `parsed` starts in the text.
        offset: usize,
        /// The state at line `parsed`'s start when it has no checkpoint
        /// (parsing goes on from the line before).
        state: Option<State>,
        /// The line being parsed, reused.
        line: String,
    }

    impl Syntect {
        /// None for plain text, a language syntect lacks. `hint`: the
        /// language's syntax hint (an extension or a name syntect knows).
        /// Loads the syntaxes when they are not loaded yet.
        pub(crate) fn new(hint: &str) -> Option<Syntect> {
            let syntax = find_syntax(hint)?;
            Some(Syntect {
                syntax,
                lines: vec![Line {
                    start: Some((ParseState::new(syntax), ScopeStack::new())),
                    ..Line::default()
                }],
                parsed: 0,
                offset: 0,
                state: None,
                line: String::new(),
            })
        }

        /// Whether the lines up to `last_line` are current.
        fn current(&self, last_line: usize) -> bool {
            self.parsed > last_line || self.parsed >= self.lines.len()
        }

        /// See [`EditorHighlighter::edited`].
        fn edited_lines(&mut self, first: usize, old_count: usize, new_count: usize) {
            if first >= self.lines.len() {
                // Past the lines parsed: nothing known changes.
                return;
            }
            // Parsing starts again at the last kept state before the edit
            // (what comes before the span is unchanged, so is the state at
            // its start).
            if self.parsed > first {
                let mut at = first;
                while self.lines[at].start.is_none() {
                    at -= 1;
                }
                // The shorter of the two sums.
                self.offset = if self.parsed - at < at {
                    self.offset
                        - self.lines[at..self.parsed]
                            .iter()
                            .map(|l| l.len)
                            .sum::<usize>()
                } else {
                    self.lines[..at].iter().map(|l| l.len).sum()
                };
                self.parsed = at;
                self.state = None;
            }
            let start = self.lines[first].start.take();
            splice(&mut self.lines, first, old_count, new_count, Line::default);
            if self.lines.len() == first {
                self.lines.push(Line::default());
            }
            let line = &mut self.lines[first];
            line.start = start;
            line.done = false;
        }

        /// Parses on (see [`EditorHighlighter::highlight`]), giving each
        /// line's tokens to `out`.
        fn parse_on(
            &mut self,
            text: &EditorText,
            last_line: usize,
            budget: Duration,
            out: &mut EditorTokens,
        ) {
            let started = Instant::now();
            let set = syntaxes();
            while self.parsed < self.lines.len() && self.parsed <= last_line {
                if self.offset > text.len() {
                    // Edits the highlighter was not told of: the text ends
                    // before the lines known.
                    log::warn!("editor: the highlighter missed an edit");
                    self.lines.truncate(self.parsed.max(1));
                    self.parsed = self.parsed.min(self.lines.len() - 1);
                    break;
                }
                let index = self.parsed;
                let newline = text.read_line(self.offset, &mut self.line);
                let len = self.line.len();
                let content = len - usize::from(newline);
                if !newline {
                    // The syntaxes expect every line with its line break.
                    self.line.push('\n');
                }
                let mut state = match self.state.take() {
                    Some(state) => state,
                    // A line parsing starts at always has a kept state;
                    // were it missing, parsing from scratch is the best
                    // guess.
                    None => self.lines[index]
                        .start
                        .clone()
                        .unwrap_or_else(|| (ParseState::new(self.syntax), ScopeStack::new())),
                };
                out.push(index, parse(&mut state, &self.line, content, set));
                let line = &mut self.lines[index];
                line.done = true;
                line.len = len;
                self.parsed = index + 1;
                self.offset += len;
                if !newline {
                    // The last line of the text.
                    self.lines.truncate(index + 1);
                    break;
                }
                let next = index + 1;
                if next == self.lines.len() {
                    self.lines.push(Line::default());
                }
                let line = &mut self.lines[next];
                if line.done && line.start.as_ref() == Some(&state) {
                    // Converged: the lines parsed before from here on
                    // hold, up to the next one an edit left unparsed,
                    // whose parse starts at the kept state before it.
                    while self.lines.get(self.parsed).is_some_and(|l| l.done) {
                        self.offset += self.lines[self.parsed].len;
                        self.parsed += 1;
                    }
                    if self.parsed < self.lines.len() {
                        while self.lines[self.parsed].start.is_none() {
                            self.parsed -= 1;
                            self.offset -= self.lines[self.parsed].len;
                        }
                    }
                } else {
                    if line.start.is_some() || next.is_multiple_of(CHECKPOINT) {
                        line.start = Some(state.clone());
                    }
                    self.state = Some(state);
                }
                if started.elapsed() >= budget {
                    break;
                }
            }
        }
    }

    impl EditorHighlighter for Syntect {
        fn edited(&mut self, edit: &EditorTextEdit) {
            self.edited_lines(edit.first_line, edit.old_line_count, edit.new_line_count);
        }

        fn highlight(
            &mut self,
            text: &EditorText,
            last_line: usize,
            budget: Duration,
            tokens: &mut EditorTokens,
        ) -> bool {
            self.parse_on(text, last_line, budget, tokens);
            self.current(last_line)
        }

        fn frontier(&self) -> usize {
            self.parsed
        }

        fn guess(
            &mut self,
            text: &EditorText,
            first_line: usize,
            offset: usize,
            last_line: usize,
            tokens: &mut EditorTokens,
        ) -> bool {
            let set = syntaxes();
            let mut state = (ParseState::new(self.syntax), ScopeStack::new());
            let mut offset = offset;
            for index in first_line..=last_line {
                if offset > text.len() {
                    break;
                }
                let newline = text.read_line(offset, &mut self.line);
                let len = self.line.len();
                let content = len - usize::from(newline);
                if !newline {
                    self.line.push('\n');
                }
                tokens.push(index, parse(&mut state, &self.line, content, set));
                offset += len;
                if !newline {
                    break;
                }
            }
            true
        }
    }

    /// The tokens of `line` (with its line break; `content` is its length
    /// without), parsed on from `state`, which it leaves at the line's end.
    fn parse(state: &mut State, line: &str, content: usize, set: &SyntaxSet) -> Tokens {
        let mut tokens = Vec::new();
        let (parser, scopes) = state;
        // A line syntect cannot parse keeps the scopes it started with;
        // the next line starts over from them.
        let Ok(operations) = parser.parse_line(line, set) else {
            return tokens;
        };
        let mut cursor = 0;
        for (index, operation) in operations {
            push(&mut tokens, cursor..index.min(content), line, scopes);
            let _ = scopes.apply(&operation);
            cursor = index;
        }
        push(&mut tokens, cursor..content, line, scopes);
        tokens
    }

    /// Adds `range` with the token of its innermost scope that has one,
    /// merged with the token before when they touch and are alike.
    fn push(tokens: &mut Tokens, range: std::ops::Range<usize>, line: &str, scopes: &ScopeStack) {
        if range.start >= range.end {
            return;
        }
        let Some(token) = scope_token(scopes, &line[range.clone()]) else {
            return;
        };
        match tokens.last_mut() {
            Some((last, last_token)) if last.end == range.start && *last_token == token => {
                last.end = range.end;
            }
            _ => tokens.push((range, token)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: Token = Token::Keyword;
    const S: Token = Token::String;

    fn line_edit(start: usize, tail: usize, rest: usize, old_len: Option<usize>) -> LineEdit {
        LineEdit {
            start,
            tail,
            rest,
            old_len,
        }
    }

    #[test]
    fn typed_text_keeps_the_colors_of_its_line() {
        // `let "ab"` (8 bytes): typing `x` after `let` joins the keyword.
        let old = vec![(0..3, K), (4..8, S)];
        let (line, last) = keep(&old, &old, line_edit(3, 4, 5, Some(8)), true);
        assert_eq!(line, vec![(0..4, K), (5..9, S)]);
        assert_eq!(last, None);
        // At the line's start it joins the token after it.
        let (line, _) = keep(&old, &old, line_edit(0, 2, 8, Some(8)), true);
        assert_eq!(line, vec![(0..5, K), (6..10, S)]);
        // Deleting `et` keeps `l` a keyword and moves the string.
        let (line, _) = keep(&old, &old, line_edit(1, 1, 5, Some(8)), true);
        assert_eq!(line, vec![(0..1, K), (2..6, S)]);
    }

    #[test]
    fn a_split_or_joined_line_keeps_its_colors() {
        let old = vec![(0..3, K), (4..8, S)];
        // Enter after `let ` with an indent of 2: `let ` / `  "ab"`.
        let (head, last) = keep(&old, &old, line_edit(4, 2, 4, Some(8)), false);
        assert_eq!(head, vec![(0..3, K)]);
        assert_eq!(last, Some(vec![(2..6, S)]));
        // Joining `let` and `"ab"` (the second line's tokens tell its length).
        let second = vec![(0..4, S)];
        let (line, _) = keep(&vec![(0..3, K)], &second, line_edit(3, 3, 4, None), true);
        assert_eq!(line, vec![(0..3, K), (3..7, S)]);
    }

    /// An app's highlighter: every `kw` is a keyword. It highlights from
    /// the first line an edit touched to the end, and keeps the edits it
    /// was told of.
    struct Words {
        dirty: usize,
        edits: std::sync::Arc<std::sync::Mutex<Vec<EditorTextEdit>>>,
    }

    impl EditorHighlighter for Words {
        fn edited(&mut self, edit: &EditorTextEdit) {
            self.dirty = self.dirty.min(edit.first_line);
            self.edits.lock().unwrap().push(*edit);
        }

        fn highlight(
            &mut self,
            text: &EditorText,
            last_line: usize,
            _budget: Duration,
            tokens: &mut EditorTokens,
        ) -> bool {
            let mut line = String::new();
            let mut offset = 0;
            let mut index = 0;
            loop {
                let newline = text.read_line(offset, &mut line);
                if index >= self.dirty && index <= last_line {
                    let words = line
                        .match_indices("kw")
                        .map(|(at, _)| (at..at + 2, crate::editor::EditorToken::Keyword));
                    tokens.line(index, words.collect::<Vec<_>>());
                    self.dirty = index + 1;
                }
                if !newline {
                    self.dirty = usize::MAX;
                    return true;
                }
                if index >= last_line {
                    return false;
                }
                offset += line.len();
                index += 1;
            }
        }

        fn frontier(&self) -> usize {
            self.dirty
        }
    }

    fn words() -> (
        Highlighter,
        std::sync::Arc<std::sync::Mutex<Vec<EditorTextEdit>>>,
    ) {
        let edits: std::sync::Arc<std::sync::Mutex<Vec<EditorTextEdit>>> = Default::default();
        let told = std::sync::Arc::clone(&edits);
        let make: Factory = Rc::new(move || {
            Box::new(Words {
                dirty: 0,
                edits: told.clone(),
            })
        });
        (Highlighter::with(&Syntax::App(make)).unwrap(), edits)
    }

    #[test]
    fn an_app_highlighter_colors_its_lines_and_hears_the_edits() {
        let (mut h, edits) = words();
        let buffer = Buffer::new("a kw\nb\nkw kw");
        h.reset(&buffer);
        let (changed, current) = h.highlight(buffer.rope(), usize::MAX, Duration::MAX);
        assert!(current);
        assert_eq!(changed, 0..3);
        assert_eq!(h.tokens(0), Some(&[(2..4, Token::Keyword)][..]));
        assert_eq!(h.tokens(1), Some(&[][..]));
        assert_eq!(
            h.tokens(2),
            Some(&[(0..2, Token::Keyword), (3..5, Token::Keyword)][..])
        );
        // Told of the whole text first, from an empty one.
        let reset = edits.lock().unwrap()[0];
        assert_eq!((reset.old_end_byte, reset.new_end_byte), (0, 12));
        assert_eq!(reset.new_end, EditorTextPoint::new(2, 5));
        // Current: no job until the text changes.
        assert!(h.job(buffer.rope(), usize::MAX, Duration::MAX).is_none());
        // Lines with tokens are not guessed.
        let guess = h.guess(buffer.rope(), 0, 0, 2);
        assert!(guess.is_none());
    }

    #[test]
    fn an_edit_tells_its_bytes_and_places() {
        // `cd` on line 1 becomes `x\ny`.
        let old = Rope::from_str("ab\ncd kw\nef");
        let new = Buffer::new("ab\nx\ny kw\nef");
        let span = LineSpan {
            first: 1,
            old_count: 1,
            new_count: 2,
        };
        let change = Change {
            range: 3..5,
            new_len: 3,
        };
        let edit = text_edit(&old, 3, &new, span, std::slice::from_ref(&change), true);
        assert_eq!(
            (edit.start_byte, edit.old_end_byte, edit.new_end_byte),
            (3, 5, 6)
        );
        assert_eq!(edit.start, EditorTextPoint::new(1, 0));
        assert_eq!(edit.old_end, EditorTextPoint::new(1, 2));
        assert_eq!(edit.new_end, EditorTextPoint::new(2, 1));
        // Joining lines 0 and 1 again: two old lines, the end after `x\ny`.
        let edit = text_edit(
            &Rope::from_str("ab\nx\ny kw\nef"),
            4,
            &Buffer::new("ab\ncd kw\nef"),
            LineSpan {
                first: 1,
                old_count: 2,
                new_count: 1,
            },
            &[Change {
                range: 3..6,
                new_len: 2,
            }],
            true,
        );
        assert_eq!(edit.old_end, EditorTextPoint::new(2, 1));
        assert_eq!(edit.new_end, EditorTextPoint::new(1, 2));
        // Several changes: one edit over the lines they touched.
        let edit = text_edit(
            &old,
            3,
            &Buffer::new("ab\nCD kw!\nef"),
            LineSpan {
                first: 1,
                old_count: 1,
                new_count: 1,
            },
            &[change.clone(), change],
            true,
        );
        assert_eq!(
            (edit.start_byte, edit.old_end_byte, edit.new_end_byte),
            (3, 8, 9)
        );
        assert_eq!(edit.old_end, EditorTextPoint::new(1, 5));
        assert_eq!(edit.new_end, EditorTextPoint::new(1, 6));
    }

    #[test]
    fn lines_a_job_highlighted_move_with_the_edits_made_meanwhile() {
        let (mut h, _) = words();
        let buffer = Buffer::new("a\nkw b\nc");
        h.reset(&buffer);
        let job = h.job(buffer.rope(), usize::MAX, Duration::MAX).unwrap();
        // Meanwhile two lines come in before line 0's end, and line 2 is
        // replaced.
        h.edited_lines(0, 1, 3);
        h.edited_lines(4, 1, 1);
        let (_, current) = h.finish(job.run());
        assert!(!current);
        // `kw b` (line 1) is line 3 now; line 2 (`c`, now 4) was replaced.
        assert_eq!(h.tokens(3), Some(&[(0..2, Token::Keyword)][..]));
        assert!(h.tokens(0).is_none() && h.tokens(4).is_none());
        // The highlighter was told: it highlights from line 0 again.
        assert_eq!(h.frontier(), 0);
    }

    #[test]
    fn app_tokens_are_sorted_apart_and_joined() {
        use crate::editor::EditorToken as T;
        let mut tokens = EditorTokens::default();
        tokens.line(
            4,
            [
                (0..2, T::Keyword),
                (2..4, T::Keyword),
                (3..6, T::String),
                (6..6, T::Number),
                (5..6, T::Number),
            ],
        );
        assert_eq!(
            tokens.lines,
            vec![(4, vec![(0..4, Token::Keyword), (4..6, Token::String)])]
        );
    }

    #[test]
    fn scopes_and_captures_name_tokens() {
        use crate::editor::EditorToken as T;
        for (scope, token) in [
            ("keyword", Some(T::Keyword)),
            ("keyword.control.rust", Some(T::Keyword)),
            ("@function.method", Some(T::Title)),
            ("entity.name.function", Some(T::Title)),
            ("type.builtin", Some(T::Built)),
            ("string.special", Some(T::String)),
            ("comment.documentation", Some(T::Comment)),
            ("constant.builtin", Some(T::Number)),
            ("number", Some(T::Number)),
            ("property", Some(T::Attr)),
            ("variable.parameter", Some(T::Attr)),
            ("variable", None),
            ("punctuation.bracket", None),
            ("operator", None),
            ("keywords", None),
        ] {
            assert_eq!(T::from_scope(scope), token, "{scope}");
        }
    }

    /// The built-in highlighter on the pipeline.
    #[cfg(feature = "highlight")]
    mod builtin {
        use super::*;

        fn highlighted(hint: &'static str, text: &str) -> Highlighter {
            let mut highlighter = Highlighter::new(hint).unwrap();
            let (_, current) =
                highlighter.highlight(&Rope::from_str(text), usize::MAX, Duration::MAX);
            assert!(current);
            highlighter
        }

        /// Every line's tokens, checked to be in order and on the line's
        /// character boundaries.
        fn all_tokens(highlighter: &Highlighter, text: &str) -> Vec<Vec<(Range<usize>, Token)>> {
            let lines: Vec<&str> = text.split('\n').collect();
            assert!(
                highlighter.tokens(lines.len()).is_none(),
                "a line past the text"
            );
            lines
                .iter()
                .enumerate()
                .map(|(index, line)| {
                    let tokens = highlighter.tokens(index).expect("highlighted").to_vec();
                    let mut at = 0;
                    for (range, _) in &tokens {
                        assert!(at <= range.start && range.start < range.end, "line {index}");
                        assert!(range.end <= line.len(), "line {index}");
                        assert!(line.is_char_boundary(range.start));
                        assert!(line.is_char_boundary(range.end));
                        at = range.end;
                    }
                    tokens
                })
                .collect()
        }

        /// The token covering `word` on `line`.
        fn token_of(
            highlighter: &Highlighter,
            text: &str,
            line: usize,
            word: &str,
        ) -> Option<Token> {
            let start = text.split('\n').nth(line).unwrap().find(word).unwrap();
            highlighter
                .tokens(line)
                .unwrap()
                .iter()
                .find(|(range, _)| range.start <= start && start + word.len() <= range.end)
                .map(|(_, token)| *token)
        }

        /// Replaces `range` of `text` with `with` and tells `highlighter`
        /// which lines changed, as the buffer would.
        fn edit(
            highlighter: &mut Highlighter,
            text: &str,
            range: Range<usize>,
            with: &str,
        ) -> String {
            let first = text[..range.start].matches('\n').count();
            let old_count = text[range.clone()].matches('\n').count() + 1;
            let new_count = with.matches('\n').count() + 1;
            highlighter.edited_lines(first, old_count, new_count);
            format!("{}{with}{}", &text[..range.start], &text[range.end..])
        }

        /// Highlights `text` until it is current and checks the tokens are
        /// those a fresh parse gives.
        fn check_fresh(
            highlighter: &mut Highlighter,
            hint: &'static str,
            text: &str,
        ) -> Range<usize> {
            let (changed, current) =
                highlighter.highlight(&Rope::from_str(text), usize::MAX, Duration::MAX);
            assert!(current);
            assert_eq!(
                all_tokens(highlighter, text),
                all_tokens(&highlighted(hint, text), text)
            );
            changed
        }

        fn rust_lines(count: usize) -> String {
            let mut text = String::from("fn main() {\n");
            for i in 0..count {
                text.push_str(&format!("    let x{i} = {i}; // 注释 👍🏽\n"));
            }
            text.push('}');
            text
        }

        #[test]
        fn rust_and_typescript_tokens() {
            let ts = "// 注释 ✓ 👋🏽\nexport async function load(id: number): Promise<string> {\n\tconst s = \"héllo\";\n  return s;\n}\n";
            let highlighter = highlighted("ts", ts);
            all_tokens(&highlighter, ts);
            assert_eq!(
                token_of(&highlighter, ts, 0, "// 注释"),
                Some(Token::Comment)
            );
            assert_eq!(
                token_of(&highlighter, ts, 1, "function"),
                Some(Token::Keyword)
            );
            assert_eq!(token_of(&highlighter, ts, 1, "load"), Some(Token::Title));
            assert_eq!(
                token_of(&highlighter, ts, 2, "\"héllo\""),
                Some(Token::String)
            );
            // The empty line after the last line break.
            assert_eq!(highlighter.tokens(5), Some(&[][..]));

            let rs = "fn main() {\n    let x: u32 = 42; // ünïcode\n}";
            let highlighter = highlighted("rs", rs);
            all_tokens(&highlighter, rs);
            assert_eq!(token_of(&highlighter, rs, 0, "fn"), Some(Token::Keyword));
            assert_eq!(token_of(&highlighter, rs, 0, "main"), Some(Token::Title));
            assert_eq!(token_of(&highlighter, rs, 1, "u32"), Some(Token::Built));
            assert_eq!(token_of(&highlighter, rs, 1, "42"), Some(Token::Number));
            assert_eq!(token_of(&highlighter, rs, 1, "// ü"), Some(Token::Comment));
            assert!(highlighter.tokens(3).is_none());
        }

        #[test]
        fn empty_and_plain_texts() {
            let highlighter = highlighted("rust", "");
            assert_eq!(highlighter.tokens(0), Some(&[][..]));
            assert!(highlighter.tokens(1).is_none());
            for plain in ["", "txt", "text", "no-such-language"] {
                assert!(Highlighter::new(plain).is_none(), "{plain}");
            }
            for hint in [
                "rs", "tsx", "ts", "js", "sh", "py", "Rust", "Makefile", "toml",
            ] {
                assert!(Highlighter::new(hint).is_some(), "{hint}");
            }
        }

        #[test]
        fn an_edit_parses_until_the_state_converges() {
            let text = rust_lines(200);
            let mut highlighter = highlighted("rust", &text);
            assert_eq!(*highlighter.parses(), 202);

            // Line 51 is `let x50 = 50;`: a longer number.
            let at = text.find("= 50;").unwrap() + 2;
            let text = edit(&mut highlighter, &text, at..at + 2, "5000");
            *highlighter.parses() = 0;
            assert_eq!(check_fresh(&mut highlighter, "rust", &text), 51..52);
            // From the kept state before it to the next one.
            assert!(*highlighter.parses() <= syntect_lines::CHECKPOINT);

            // A line in, a line out: the lines after shift.
            let at = text.find("    let x10").unwrap();
            let text = edit(&mut highlighter, &text, at..at, "    let s = \"新\";\n");
            *highlighter.parses() = 0;
            check_fresh(&mut highlighter, "rust", &text);
            assert!(*highlighter.parses() <= 2 * syntect_lines::CHECKPOINT);
            let start = text.find("    let x3 ").unwrap();
            let end = text.find("    let x7 ").unwrap();
            let text = edit(&mut highlighter, &text, start..end, "");
            *highlighter.parses() = 0;
            check_fresh(&mut highlighter, "rust", &text);
            assert!(*highlighter.parses() <= 2 * syntect_lines::CHECKPOINT);

            // Nothing changed: nothing to parse.
            *highlighter.parses() = 0;
            let (changed, current) =
                highlighter.highlight(&Rope::from_str(&text), usize::MAX, Duration::MAX);
            assert!(current && changed.is_empty());
            assert_eq!(*highlighter.parses(), 0);
        }

        #[test]
        fn opening_a_block_comment_highlights_the_lines_after_it() {
            let original = rust_lines(20);
            let mut highlighter = highlighted("rust", &original);
            let lines = original.split('\n').count();
            assert_eq!(
                token_of(&highlighter, &original, 10, "let"),
                Some(Token::Keyword)
            );

            let at = original.find("    let x2 ").unwrap();
            let text = edit(&mut highlighter, &original, at..at, "/* ");
            let changed = check_fresh(&mut highlighter, "rust", &text);
            assert_eq!(changed, 3..lines);
            for line in 3..lines {
                assert!(
                    highlighter
                        .tokens(line)
                        .unwrap()
                        .iter()
                        .all(|(_, token)| *token == Token::Comment),
                    "line {line}"
                );
            }

            // Closing it again restores the lines after it.
            let text = edit(&mut highlighter, &text, at..at + 3, "");
            assert_eq!(text, original);
            assert_eq!(check_fresh(&mut highlighter, "rust", &text), 3..lines);
            assert_eq!(
                token_of(&highlighter, &text, 10, "let"),
                Some(Token::Keyword)
            );
        }

        #[test]
        fn a_budget_parses_on_over_several_calls() {
            let text = rust_lines(50);
            let rope = Rope::from_str(&text);
            let mut highlighter = Highlighter::new("rust").unwrap();
            let mut calls = 0;
            while !highlighter.highlight(&rope, usize::MAX, Duration::ZERO).1 {
                calls += 1;
                assert!(calls < 100);
            }
            assert!(calls > 1);
            assert_eq!(
                all_tokens(&highlighter, &text),
                all_tokens(&highlighted("rust", &text), &text)
            );

            // Only up to the last line asked for.
            let mut highlighter = Highlighter::new("rust").unwrap();
            let (changed, current) = highlighter.highlight(&rope, 9, Duration::MAX);
            assert!(current);
            assert_eq!(changed, 0..10);
            assert!(highlighter.tokens(9).is_some() && highlighter.tokens(10).is_none());

            // An edit while lines after it are still unparsed.
            let at = text.find("    let x3 ").unwrap();
            let text = edit(&mut highlighter, &text, at..at, "/*\n");
            check_fresh(&mut highlighter, "rust", &text);
            let at = text.find("    let x40 ").unwrap();
            let text = edit(&mut highlighter, &text, at..text.len(), "*/ }");
            check_fresh(&mut highlighter, "rust", &text);
        }

        #[test]
        fn edits_while_a_job_parses_are_given_to_it_after() {
            let text = rust_lines(300);
            let mut highlighter = highlighted("rust", &text);
            // A block comment opens at line 3: the job parses on from there
            // while, meanwhile, line 1 changes and the comment closes.
            let at = text.find("    let x2 ").unwrap();
            let text = edit(&mut highlighter, &text, at..at, "/* ");
            let job = highlighter
                .job(&Rope::from_str(&text), usize::MAX, Duration::MAX)
                .unwrap();
            assert!(
                highlighter
                    .job(&Rope::from_str(&text), usize::MAX, Duration::MAX)
                    .is_none()
            );
            let at = text.find("    let x0 ").unwrap();
            let text = edit(&mut highlighter, &text, at..at, "// ");
            let at = text.find("/* ").unwrap();
            let text = edit(&mut highlighter, &text, at..at + 3, "");
            let (_, current) = highlighter.finish(job.run());
            assert!(!current || highlighter.frontier() < 3);
            check_fresh(&mut highlighter, "rust", &text);
        }

        #[test]
        fn a_guess_shows_lines_far_ahead_until_the_parse_reaches_them() {
            let text = rust_lines(1000);
            let rope = Rope::from_str(&text);
            let mut highlighter = Highlighter::new("rust").unwrap();
            let offset = text.match_indices('\n').nth(899).unwrap().0 + 1;
            let guess = highlighter.guess(&rope, 900, offset, 950).unwrap();
            let changed = highlighter.guessed(guess.run());
            assert_eq!(changed, 900..951);
            assert!(highlighter.tokens(899).is_none());
            assert_eq!(
                token_of(&highlighter, &text, 920, "let"),
                Some(Token::Keyword)
            );
            assert!(highlighter.guess(&rope, 900, offset, 950).is_none());
            // The parse from the start takes the lines over.
            check_fresh(&mut highlighter, "rust", &text);
        }
    }
}
