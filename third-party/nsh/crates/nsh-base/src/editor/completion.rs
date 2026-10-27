//! Completion, built into the editor: what asks the app for suggestions
//! (`onCompletionRequest` as a word is typed, after a trigger character or
//! on `showCompletions`), the list the app's answer fills
//! (`presentCompletions`), filtered as the user goes on typing, its keys,
//! the insertion of what is accepted, and inline completion (ghost text the
//! app suggests after a pause in typing, `onInlineCompletionRequest`).
//!
//! The editor owns it rather than the app because a view's key bindings
//! win over the app's: while the editor has the focus, Up, Down, Enter,
//! Tab and Escape are its own, so only the editor can give them to a list.
//! The list's look is a default of the theme's tokens, every part of
//! which the app restyles (`completionMenu`, `completionItem`, ...).
//!
//! A *session* lasts from a request until the list closes. It keeps where
//! the query starts (`queryStart`): the query is the text from there to
//! the caret, and typing on in that word refines it locally, without
//! asking again unless the last answer was `incomplete`. It ends when the
//! caret leaves the word (left of its start or across a character that is
//! not a word's), an edit lands elsewhere, the selection grows, a
//! character that is neither a word's nor a trigger is typed, the editor
//! loses the focus, the caret scrolls out of view, or on Escape and
//! accepting. Answers to an older request, or to a session that ended, are
//! dropped.
//!
//! Accepting replaces the item's `range` (default: the query) with its
//! `insertText` (default its label) as one undo step at the primary caret,
//! and at every other caret preceded by the same text, as VS Code does; a
//! caret preceded by something else is left as it is. The text goes in as
//! it is: snippet placeholders (`$1`) are not expanded.

use std::{cell::RefCell, ops::Range, rc::Rc, time::Duration};

use nsh_core::{
    element::{EventKind, EventPayload},
    keymap::When,
    overlay::{Align, Placement},
    prelude::*,
    time::{Instant, now},
};

use super::{
    EditorEvent, EditorPart, EditorPosition, EditorRange,
    buffer::Change,
    controller::Ed,
    hooks::{rows_in_view, utf16_offset},
    state::State,
    view::parts,
};
use crate::theme;

/// The rows the list shows at most; more scroll.
const VISIBLE_ROWS: usize = 10;
/// The rows of a page (Page Up, Page Down).
const PAGE_ROWS: usize = VISIBLE_ROWS - 1;
/// The widest the documentation beside the list grows before it wraps.
const DOCUMENTATION_WIDTH: f32 = 320.0;
/// The room between a row's kind, label and detail.
const ROW_GAP: f32 = 6.0;
/// The room before and after a row's content.
const ROW_PADDING: f32 = 8.0;
/// The chars of a label's detail the list makes room for.
const DETAIL_CHARS: usize = 32;
/// At most this many chars of a label or filter text are matched.
const MATCH_CHARS: usize = 256;

/// A suggestion of an editor's completion (`presentCompletions`), shaped
/// as a language server's `CompletionItem` (its other keys are ignored).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorCompletionItem {
    /// What the list shows, and what is inserted without `insertText`.
    pub label: SharedString,
    /// What it is: a short muted label before it.
    #[prop(skip_none)]
    pub kind: Option<EditorCompletionKind>,
    /// More about it (a type, a signature), right-aligned after the label.
    #[prop(skip_none)]
    pub detail: Option<SharedString>,
    /// Its documentation, plain text, shown beside the list while it is
    /// selected.
    #[prop(skip_none)]
    pub documentation: Option<SharedString>,
    /// What accepting it inserts (default `label`).
    #[prop(skip_none)]
    pub insert_text: Option<SharedString>,
    /// What the query is matched against (default `label`).
    #[prop(skip_none)]
    pub filter_text: Option<SharedString>,
    /// What it is ordered by among equal matches (default `label`).
    #[prop(skip_none)]
    pub sort_text: Option<SharedString>,
    /// What accepting it replaces (default the query: from `queryStart`
    /// to the caret).
    #[prop(skip_none)]
    pub range: Option<EditorRange>,
}

impl EditorCompletionItem {
    /// An item showing and inserting `label`.
    pub fn new(label: impl Into<SharedString>) -> EditorCompletionItem {
        EditorCompletionItem {
            label: label.into(),
            ..Default::default()
        }
    }
}

/// What a completion item is, as a language server's
/// `CompletionItemKind` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorCompletionKind {
    /// Plain text.
    Text,
    /// A method.
    Method,
    /// A function.
    Function,
    /// A constructor.
    Constructor,
    /// A field.
    Field,
    /// A variable.
    Variable,
    /// A class.
    Class,
    /// An interface.
    Interface,
    /// A module.
    Module,
    /// A property.
    Property,
    /// A unit.
    Unit,
    /// A value.
    Value,
    /// An enum.
    Enum,
    /// A keyword.
    Keyword,
    /// A snippet.
    Snippet,
    /// A color.
    Color,
    /// A file.
    File,
    /// A reference.
    Reference,
    /// A folder.
    Folder,
    /// A member of an enum.
    EnumMember,
    /// A constant.
    Constant,
    /// A struct.
    Struct,
    /// An event.
    Event,
    /// An operator.
    Operator,
    /// A type parameter.
    TypeParameter,
}

impl EditorCompletionKind {
    /// The short label the list shows.
    fn short(self) -> &'static str {
        use EditorCompletionKind as K;
        match self {
            K::Text => "abc",
            K::Method | K::Function => "fn",
            K::Constructor => "new",
            K::Field => "fld",
            K::Variable => "var",
            K::Class => "cls",
            K::Interface => "ifc",
            K::Module => "mod",
            K::Property => "prop",
            K::Unit => "unit",
            K::Value => "val",
            K::Enum => "enum",
            K::Keyword => "kw",
            K::Snippet => "snip",
            K::Color => "clr",
            K::File => "file",
            K::Reference => "ref",
            K::Folder => "dir",
            K::EnumMember => "mem",
            K::Constant => "const",
            K::Struct => "st",
            K::Event => "ev",
            K::Operator => "op",
            K::TypeParameter => "T",
        }
    }
}

/// Why an editor asks for completions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorCompletionTrigger {
    /// A word is being typed.
    #[default]
    Typing,
    /// One of `completionTriggerCharacters` was typed (`character`).
    Character,
    /// `showCompletions` (the ref, or `run("showCompletions")`).
    Invoked,
}

/// An editor asks for completions at its caret (`onCompletionRequest`):
/// answer with `presentCompletions(id, items)`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorCompletionRequest {
    /// Which request this is: they count up, and only the answer to the
    /// last one is shown.
    pub id: u32,
    /// The caret, as an offset of the text (UTF-16 code units).
    pub offset: u32,
    /// The caret's position.
    pub position: EditorPosition,
    /// What was typed of the word, from `queryStart` to the caret (empty
    /// after a trigger character).
    pub query: String,
    /// Where the query starts (UTF-16 code units): what an item without a
    /// `range` replaces, to the caret.
    pub query_start: u32,
    /// Why it asks.
    pub trigger: EditorCompletionTrigger,
    /// The trigger character typed, for `trigger` `character`.
    #[prop(skip_none)]
    pub character: Option<String>,
}

/// A completion item was accepted and inserted (`onCompletionAccept`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorCompletionAcceptEvent {
    /// The item, as the app presented it.
    pub item: EditorCompletionItem,
}

/// An editor asks for an inline completion at its caret after a pause in
/// typing (`onInlineCompletionRequest`): answer with
/// `presentInlineCompletion(id, text)`.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorInlineCompletionRequest {
    /// Which request this is: only the answer to the last one is shown.
    pub id: u32,
    /// The caret, as an offset of the text (UTF-16 code units).
    pub offset: u32,
    /// The caret's position.
    pub position: EditorPosition,
}

// Filtering.

/// An item the query matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit {
    /// The item's index.
    pub(crate) index: usize,
    /// The bytes of its label the query matched.
    pub(crate) highlights: Vec<Range<usize>>,
}

/// Whether two chars are the same in any case.
fn same_char(a: char, b: char) -> bool {
    a == b || a.eq_ignore_ascii_case(&b) || a.to_lowercase().eq(b.to_lowercase())
}

/// How `query` matches `text` as a subsequence, in any case: the most
/// compact match (the fewest chars between its first and last), the
/// earliest of those. `None` when it does not match.
fn fuzzy(text: &str, query: &str) -> Option<Fuzzy> {
    let query: Vec<char> = query.chars().collect();
    let chars: Vec<(usize, char)> = text.char_indices().take(MATCH_CHARS).collect();
    if query.is_empty() {
        return Some(Fuzzy::default());
    }
    let mut best: Option<(usize, Vec<usize>)> = None;
    for start in 0..chars.len() {
        if !same_char(chars[start].1, query[0]) {
            continue;
        }
        let mut at = vec![start];
        let mut i = start + 1;
        for &q in &query[1..] {
            while i < chars.len() && !same_char(chars[i].1, q) {
                i += 1;
            }
            if i == chars.len() {
                break;
            }
            at.push(i);
            i += 1;
        }
        if at.len() < query.len() {
            // No later start matches all of it either.
            break;
        }
        let span = at[at.len() - 1] - at[0];
        if best.as_ref().is_none_or(|(s, _)| span < *s) {
            best = Some((span, at));
        }
        if span + 1 == query.len() {
            break;
        }
    }
    let (span, at) = best?;
    let case_misses = at
        .iter()
        .zip(&query)
        .filter(|(i, q)| chars[**i].1 != **q)
        .count();
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for i in &at {
        let (byte, c) = chars[*i];
        let end = byte + c.len_utf8();
        match ranges.last_mut() {
            Some(last) if last.end == byte => last.end = end,
            _ => ranges.push(byte..end),
        }
    }
    Some(Fuzzy {
        first: at[0],
        gaps: span + 1 - query.len(),
        case_misses,
        ranges,
    })
}

/// A match of [`fuzzy`].
#[derive(Debug, Default)]
struct Fuzzy {
    /// The char the match starts at.
    first: usize,
    /// The chars between the matched ones.
    gaps: usize,
    /// The matched chars in another case than the query's.
    case_misses: usize,
    /// The bytes matched, adjacent ones joined.
    ranges: Vec<Range<usize>>,
}

/// The items `query` matches, best first: those it is a prefix of, then
/// the most compact matches, those in the query's case (`rec` puts
/// `receipt` before `Receipt`), then by `sortText` (or label); an empty query
/// keeps every item, in `sortText` order.
pub(crate) fn filter(items: &[EditorCompletionItem], query: &str) -> Vec<Hit> {
    // In any case first, so `string` sorts beside `String`.
    let sort_key = |item: &EditorCompletionItem| -> (String, String) {
        let key = item.sort_text.as_ref().unwrap_or(&item.label);
        (key.to_lowercase(), key.to_string())
    };
    // (not a prefix, gaps, first char, case misses), the sort key, the hit.
    type Ranked = ((bool, usize, usize, usize), (String, String), Hit);
    let mut ranked: Vec<Ranked> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let target = item.filter_text.as_ref().unwrap_or(&item.label);
            let found = fuzzy(target, query)?;
            let prefix = found.first == 0 && found.gaps == 0;
            let highlights = if query.is_empty() {
                Vec::new()
            } else if item.filter_text.is_none() || target == &item.label {
                found.ranges
            } else {
                fuzzy(&item.label, query)
                    .map(|f| f.ranges)
                    .unwrap_or_default()
            };
            Some((
                (!prefix, found.gaps, found.first, found.case_misses),
                sort_key(item),
                Hit { index, highlights },
            ))
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    ranked.into_iter().map(|(_, _, hit)| hit).collect()
}

/// `label` cut into runs, each matched (`true`) by the query or not.
pub(crate) fn runs<'a>(label: &'a str, highlights: &[Range<usize>]) -> Vec<(&'a str, bool)> {
    let mut out = Vec::new();
    let mut at = 0;
    for r in highlights {
        let (start, end) = (r.start.min(label.len()), r.end.min(label.len()));
        if start < at || !label.is_char_boundary(start) || !label.is_char_boundary(end) {
            continue;
        }
        if start > at {
            out.push((&label[at..start], false));
        }
        if end > start {
            out.push((&label[start..end], true));
        }
        at = end;
    }
    if at < label.len() {
        out.push((&label[at..], false));
    }
    out
}

/// The word characters before `offset` on its line: where a word typed up
/// to there starts.
pub(crate) fn word_start(st: &State, offset: usize) -> usize {
    let line_start = st.buffer.line_start(st.buffer.line_of(offset));
    let mut start = offset;
    while start > line_start {
        match st.buffer.char_before(start) {
            Some(c) if st.language.is_word_char(c) => start -= c.len_utf8(),
            _ => break,
        }
    }
    start
}

/// Whether a session whose query starts at `query_start` still holds: one
/// caret's worth of selection (a caret), at or after the start, on its
/// line, with only word characters between them.
fn holds(st: &State, query_start: usize) -> bool {
    let primary = st.selections.primary();
    if !primary.is_empty() {
        return false;
    }
    let caret = primary.head;
    if caret < query_start || st.buffer.line_of(caret) != st.buffer.line_of(query_start) {
        return false;
    }
    st.buffer
        .slice(query_start..caret)
        .chars()
        .all(|c| st.language.is_word_char(c))
}

// State.

/// The list the app's answer filled.
#[derive(Debug)]
struct Menu {
    items: Vec<EditorCompletionItem>,
    /// The app's list is not all there is: typing on asks again.
    incomplete: bool,
    /// The items the query matches, best first.
    hits: Vec<Hit>,
    /// Which hit is selected.
    selected: usize,
    /// Any hit has a kind (the column shows).
    kinds: bool,
}

/// A completion session.
#[derive(Debug)]
struct Session {
    /// The last request made.
    id: u32,
    /// Where the query starts.
    query_start: usize,
    trigger: EditorCompletionTrigger,
    /// The buffer's version the session was last checked at.
    version: u64,
    menu: Option<Menu>,
}

/// An inline completion: asked for, or shown.
#[derive(Debug, Clone)]
struct Inline {
    /// The request (0 while it waits for the pause to end).
    id: u32,
    /// The caret it is for.
    at: usize,
    /// The buffer's version it is for.
    version: u64,
    /// The app's text, once shown.
    text: Option<String>,
}

#[derive(Debug, Default)]
struct Inner {
    /// The last request's id (completions and inline completions count
    /// apart).
    last_id: u32,
    last_inline_id: u32,
    session: Option<Session>,
    inline: Option<Inline>,
    /// When the pause before an inline request ends.
    inline_due: Option<Instant>,
    /// A task waits for it.
    inline_waiting: bool,
    /// An accepted item is going in: typing hooks stay out of it.
    inserting: bool,
    /// The width of a `0` in the font, per font.
    zero: Option<(String, Points)>,
}

/// The editor's completion. Cloned with the controller.
#[derive(Clone)]
pub(crate) struct Completion {
    inner: Rc<RefCell<Inner>>,
    /// The list changed: items, matches, selection.
    rev: Signal<u64>,
    /// The list shows (a session with matches).
    open: Signal<bool>,
    /// An inline completion shows.
    ghost: Signal<bool>,
    /// The list's scroll offset.
    list_y: Signal<Points>,
    /// What the list is placed against: the query's start on the caret's
    /// row.
    anchor: ElementRef,
    list: ElementRef,
}

impl Completion {
    pub(crate) fn new() -> Completion {
        Completion {
            inner: Rc::default(),
            rev: signal(0),
            open: signal(false),
            ghost: signal(false),
            list_y: signal(px(0.0)),
            anchor: element_ref(),
            list: element_ref(),
        }
    }
}

impl Ed {
    /// Whether completion is on.
    fn completion_on(&self) -> bool {
        self.props.completion.get_untracked()
    }

    /// The keys of the list and of inline completion, bound while they
    /// show (after the editor's own, so they win), and the list closing
    /// when the caret scrolls out of view.
    pub(crate) fn follow_completion(&self) {
        let ed = self.clone();
        effect(move || {
            if !ed.completion.open.get() {
                return;
            }
            let bind = |keys: &str, repeat: bool, f: Rc<dyn Fn(&Ed)>| {
                let e = ed.clone();
                on_key_with(
                    keys,
                    KeyOptions {
                        when: When::Always,
                        repeat,
                    },
                    move |_| f(&e),
                );
            };
            bind("up", true, Rc::new(|e| e.move_completion(-1, true)));
            bind("down", true, Rc::new(|e| e.move_completion(1, true)));
            bind("ctrl+p", true, Rc::new(|e| e.move_completion(-1, true)));
            bind("ctrl+n", true, Rc::new(|e| e.move_completion(1, true)));
            let page = PAGE_ROWS as isize;
            bind(
                "pageup",
                true,
                Rc::new(move |e| e.move_completion(-page, false)),
            );
            bind(
                "pagedown",
                true,
                Rc::new(move |e| e.move_completion(page, false)),
            );
            bind("enter", false, Rc::new(|e| e.accept_completion(None)));
            bind("tab", false, Rc::new(|e| e.accept_completion(None)));
            bind("escape", false, Rc::new(|e| e.hide_completions()));
        });
        let ed = self.clone();
        effect(move || {
            if !ed.completion.ghost.get() || ed.completion.open.get() {
                return;
            }
            let e = ed.clone();
            on_key_with("tab", always(), move |_| e.accept_inline_completion());
            let e = ed.clone();
            on_key_with("escape", always(), move |_| e.hide_inline_completion());
        });
        let ed = self.clone();
        effect(move || {
            ed.scroll_y.get();
            ed.viewport.get();
            if !ed.completion.open.get_untracked() && !ed.completion.ghost.get_untracked() {
                return;
            }
            let hidden = {
                let st = ed.st.borrow();
                let (row, _) = st.display.locate(&st.buffer, st.primary_head());
                let rows = rows_in_view(
                    &st,
                    ed.scroll_y.get_untracked(),
                    ed.rows_top.get_untracked(),
                    ed.viewport.get_untracked().height,
                );
                !rows.contains(&row)
            };
            if hidden {
                ed.hide_completions();
                ed.hide_inline_completion();
            }
        });
    }

    // What the editor does.

    /// Text was typed at the carets (and changed the text).
    pub(crate) fn completion_typed(&self, text: &str) {
        if !self.completion_on() || self.completion.inner.borrow().inserting {
            return;
        }
        self.hide_inline_completion();
        enum Next {
            Request(usize, EditorCompletionTrigger, Option<String>, bool),
            Refine,
            Close,
            Nothing,
        }
        let next = {
            let st = self.st.borrow();
            let inner = self.completion.inner.borrow();
            let primary = st.selections.primary();
            let caret = primary.head;
            let last = text.chars().next_back();
            let trigger = (primary.is_empty())
                .then(|| {
                    self.props
                        .completion_trigger_characters
                        .with_untracked(|all| {
                            all.iter()
                                .find(|t| {
                                    !t.is_empty()
                                        && caret >= t.len()
                                        && st.buffer.slice(caret - t.len()..caret) == t.as_str()
                                        && text.ends_with(t.chars().next_back().unwrap_or(' '))
                                })
                                .map(|t| t.to_string())
                        })
                })
                .flatten();
            if let Some(character) = trigger {
                Next::Request(
                    caret,
                    EditorCompletionTrigger::Character,
                    Some(character),
                    false,
                )
            } else if last.is_some_and(|c| st.language.is_word_char(c)) && primary.is_empty() {
                match &inner.session {
                    Some(s) if holds(&st, s.query_start) => {
                        match s.menu.as_ref().is_some_and(|m| m.incomplete) {
                            true => Next::Request(s.query_start, s.trigger, None, true),
                            false => Next::Refine,
                        }
                    }
                    _ => {
                        // At a word's end only: typing inside a word is
                        // editing it.
                        let at_end = st
                            .buffer
                            .char_at(caret)
                            .is_none_or(|c| !st.language.is_word_char(c));
                        match at_end {
                            true => Next::Request(
                                word_start(&st, caret),
                                EditorCompletionTrigger::Typing,
                                None,
                                false,
                            ),
                            false => Next::Close,
                        }
                    }
                }
            } else if inner.session.is_some() {
                Next::Close
            } else {
                Next::Nothing
            }
        };
        match next {
            Next::Request(start, trigger, character, again) => {
                self.request_completions(start, trigger, character, again)
            }
            Next::Refine => self.refine_completions(),
            Next::Close => self.hide_completions(),
            Next::Nothing => {}
        }
        self.schedule_inline_completion();
    }

    /// The text changed other than by typing (Backspace, a paste, undo,
    /// the ref): the session holds while the edits were in its word.
    pub(crate) fn completion_edited(&self, changes: &[Change]) {
        if !self.completion_on() || self.completion.inner.borrow().inserting {
            return;
        }
        self.hide_inline_completion();
        let keep = {
            let st = self.st.borrow();
            let inner = self.completion.inner.borrow();
            match &inner.session {
                None => return,
                Some(s) => {
                    let caret = st.primary_head();
                    changes.iter().all(|c| c.range.start >= s.query_start)
                        && holds(&st, s.query_start)
                        // A word deleted back to its start was given up.
                        && !(s.trigger == EditorCompletionTrigger::Typing && caret == s.query_start)
                }
            }
        };
        if !keep {
            self.hide_completions();
            return;
        }
        let again = {
            let inner = self.completion.inner.borrow();
            inner.session.as_ref().and_then(|s| {
                s.menu
                    .as_ref()
                    .filter(|m| m.incomplete)
                    .map(|_| (s.query_start, s.trigger))
            })
        };
        match again {
            Some((start, trigger)) => self.request_completions(start, trigger, None, true),
            None => self.refine_completions(),
        }
    }

    /// The carets moved without an edit.
    pub(crate) fn completion_moved(&self) {
        if !self.completion_on() {
            return;
        }
        self.hide_inline_completion();
        let keep = {
            let st = self.st.borrow();
            let inner = self.completion.inner.borrow();
            match &inner.session {
                None => return,
                Some(s) => holds(&st, s.query_start),
            }
        };
        match keep {
            true => self.refine_completions(),
            false => self.hide_completions(),
        }
    }

    /// The editor lost the focus.
    pub(crate) fn completion_blurred(&self) {
        self.hide_completions();
        self.hide_inline_completion();
    }

    // Requests and answers.

    /// Asks for completions at the caret, the query from `query_start`.
    /// `again`: the session's word asked about again (the last answer was
    /// incomplete), keeping its list meanwhile.
    fn request_completions(
        &self,
        query_start: usize,
        trigger: EditorCompletionTrigger,
        character: Option<String>,
        again: bool,
    ) {
        let event = {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            inner.last_id += 1;
            let id = inner.last_id;
            let caret = st.primary_head();
            let version = st.buffer.version();
            match &mut inner.session {
                Some(s) if again => {
                    s.id = id;
                    s.version = version;
                }
                _ => {
                    inner.session = Some(Session {
                        id,
                        query_start,
                        trigger,
                        version,
                        menu: None,
                    });
                }
            }
            EditorCompletionRequest {
                id,
                offset: utf16_offset(&st.buffer, caret),
                position: st.position(caret),
                query: st.buffer.slice(query_start..caret),
                query_start: utf16_offset(&st.buffer, query_start),
                trigger,
                character,
            }
        };
        self.refine_completions();
        self.cx.emit(EditorEvent::CompletionRequest(event));
    }

    /// `showCompletions`: asks at the caret, the query the word before it.
    pub(crate) fn show_completions(&self) {
        if !self.completion_on() || self.props.read_only.get_untracked() {
            return;
        }
        let start = {
            let st = self.st.borrow();
            if !st.selections.primary().is_empty() {
                return;
            }
            word_start(&st, st.primary_head())
        };
        self.hide_completions();
        self.hide_inline_completion();
        self.focus();
        self.request_completions(start, EditorCompletionTrigger::Invoked, None, false);
    }

    /// The app's answer to request `id`: the list shows, filtered by the
    /// query; dropped when stale.
    pub(crate) fn present_completions(
        &self,
        id: u32,
        items: Vec<EditorCompletionItem>,
        incomplete: bool,
    ) {
        let fresh = {
            let st = self.st.borrow();
            let inner = self.completion.inner.borrow();
            match &inner.session {
                Some(s) if s.id == id => {
                    s.version == st.buffer.version() && holds(&st, s.query_start)
                }
                // Another request since, or a session that ended.
                _ => return,
            }
        };
        if !fresh || !self.focused.get_untracked() || items.is_empty() {
            self.hide_completions();
            return;
        }
        if let Some(s) = &mut self.completion.inner.borrow_mut().session {
            s.menu = Some(Menu {
                items,
                incomplete,
                hits: Vec::new(),
                selected: 0,
                kinds: false,
            });
        }
        self.hide_inline_completion();
        self.refine_completions();
    }

    /// Filters the list by the query as it is now, the best match selected.
    fn refine_completions(&self) {
        let shown = {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            let Some(s) = &mut inner.session else { return };
            s.version = st.buffer.version();
            let query = st
                .buffer
                .slice(s.query_start..st.primary_head().max(s.query_start));
            match &mut s.menu {
                Some(menu) => {
                    menu.hits = filter(&menu.items, &query);
                    menu.selected = 0;
                    menu.kinds = menu.hits.iter().any(|h| menu.items[h.index].kind.is_some());
                    !menu.hits.is_empty()
                }
                // Asked, not answered yet.
                None => false,
            }
        };
        if self.completion.list_y.get_untracked() != px(0.0) {
            self.completion.list_y.set(px(0.0));
            self.completion
                .list
                .scroll_to(Point::new(px(0.0), px(0.0)), false);
        }
        if self.completion.open.get_untracked() != shown {
            self.completion.open.set(shown);
        }
        self.completion.rev.update(|r| *r += 1);
    }

    /// Closes the list and forgets the session.
    pub(crate) fn hide_completions(&self) {
        let had = self.completion.inner.borrow_mut().session.take().is_some();
        if had {
            self.completion.open.set(false);
            self.completion.rev.update(|r| *r += 1);
        }
    }

    /// Moves the selection in the list by `by`, around the ends with `wrap`.
    fn move_completion(&self, by: isize, wrap: bool) {
        let selected = {
            let mut inner = self.completion.inner.borrow_mut();
            let Some(menu) = inner.session.as_mut().and_then(|s| s.menu.as_mut()) else {
                return;
            };
            let count = menu.hits.len() as isize;
            if count == 0 {
                return;
            }
            let at = menu.selected as isize + by;
            menu.selected = if wrap {
                at.rem_euclid(count)
            } else {
                at.clamp(0, count - 1)
            } as usize;
            menu.selected
        };
        self.completion.rev.update(|r| *r += 1);
        self.reveal_completion(selected);
    }

    /// Marks hit `index` (the pointer is over it).
    fn mark_completion(&self, index: usize) {
        let changed = {
            let mut inner = self.completion.inner.borrow_mut();
            match inner.session.as_mut().and_then(|s| s.menu.as_mut()) {
                Some(menu) if index < menu.hits.len() && menu.selected != index => {
                    menu.selected = index;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.completion.rev.update(|r| *r += 1);
        }
    }

    /// Scrolls the list so that hit `index` shows.
    fn reveal_completion(&self, index: usize) {
        let h = self.st.borrow().line_height();
        let y = self.completion.list_y.get_untracked();
        let top = h * index as f32;
        let height = h * VISIBLE_ROWS as f32;
        let target = if top < y {
            Some(top)
        } else if top + h > y + height {
            Some(top + h - height)
        } else {
            None
        };
        if let Some(target) = target {
            self.completion.list_y.set(target);
            self.completion
                .list
                .scroll_to(Point::new(px(0.0), target), false);
        }
    }

    /// Accepts hit `index` (the selected one with `None`): its text
    /// replaces its range, as one undo step.
    fn accept_completion(&self, index: Option<usize>) {
        let found = {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            let Some(s) = inner.session.take() else {
                return;
            };
            let Some(menu) = s.menu else { return };
            let Some(hit) = menu.hits.get(index.unwrap_or(menu.selected)) else {
                return;
            };
            let item = menu.items[hit.index].clone();
            let caret = st.primary_head();
            let range = match item.range {
                Some(r) => {
                    let (a, b) = (st.offset_of(r.start), st.offset_of(r.end));
                    a.min(b)..a.max(b)
                }
                None => s.query_start..caret,
            };
            let text = item
                .insert_text
                .clone()
                .unwrap_or_else(|| item.label.clone());
            Some((item, completion_edits(&st, range, text.as_ref())))
        };
        self.completion.open.set(false);
        self.completion.rev.update(|r| *r += 1);
        let Some((item, edits)) = found else { return };
        self.insert_completion(edits);
        self.cx
            .emit(EditorEvent::CompletionAccept(EditorCompletionAcceptEvent {
                item,
            }));
    }

    /// Applies `edits` as one undo step, out of the typing hooks' way.
    fn insert_completion(&self, edits: Vec<(Range<usize>, String)>) {
        self.completion.inner.borrow_mut().inserting = true;
        self.replace_in_one_step(edits);
        self.completion.inner.borrow_mut().inserting = false;
        // What the sink held was typed before the insertion: an input
        // method must not replace it now.
        self.empty_sink();
        self.focus();
    }

    /// Replaces byte ranges of the text (not overlapping) as one undo
    /// step of its own, the selections carried through.
    pub(crate) fn replace_in_one_step(&self, edits: Vec<(Range<usize>, String)>) {
        let outcome = {
            let mut st = self.st.borrow_mut();
            st.buffer.break_undo_group();
            let outcome = st.editing(1, |e| e.replace(edits));
            st.buffer.break_undo_group();
            outcome
        };
        self.after(outcome);
    }

    /// The ref's `edit`: the app's replacements, by position, as one undo
    /// step; overlapping ones after the first are dropped.
    pub(crate) fn edit(&self, edits: &[super::EditorEdit]) {
        let ranges = {
            let st = self.st.borrow();
            let mut ranges: Vec<(Range<usize>, String)> = edits
                .iter()
                .map(|e| {
                    let (a, b) = (st.offset_of(e.range.start), st.offset_of(e.range.end));
                    (a.min(b)..a.max(b), e.text.to_string())
                })
                .collect();
            ranges.sort_by_key(|(r, _)| (r.start, r.end));
            let mut kept: Vec<(Range<usize>, String)> = Vec::with_capacity(ranges.len());
            for (range, text) in ranges {
                let overlaps = kept.last().is_some_and(|(last, _)| {
                    range.start < last.end || (range.start == last.start && last.is_empty())
                });
                if !overlaps {
                    kept.push((range, text));
                }
            }
            kept
        };
        if !ranges.is_empty() {
            self.replace_in_one_step(ranges);
        }
    }

    // Inline completion.

    /// Asks for an inline completion once typing pauses: one task waits,
    /// whatever the number of keystrokes.
    fn schedule_inline_completion(&self) {
        let delay = self.props.inline_completion_delay.get_untracked().max(0.0);
        {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            if !st.selections.primary().is_empty() {
                return;
            }
            inner.inline = Some(Inline {
                id: 0,
                at: st.primary_head(),
                version: st.buffer.version(),
                text: None,
            });
            inner.inline_due = Some(now() + Duration::from_secs_f64(delay / 1000.0));
            if inner.inline_waiting {
                return;
            }
            inner.inline_waiting = true;
        }
        let ed = self.clone();
        spawn(async move {
            loop {
                let due = ed.completion.inner.borrow().inline_due;
                let Some(due) = due else { break };
                if now() < due {
                    timer_until(due).await;
                    continue;
                }
                ed.completion.inner.borrow_mut().inline_due = None;
                ed.request_inline_completion();
                break;
            }
            ed.completion.inner.borrow_mut().inline_waiting = false;
        });
    }

    /// The pause ended: asks, unless the caret or the text moved on or the
    /// list shows.
    fn request_inline_completion(&self) {
        if self.completion.open.get_untracked() || !self.focused.get_untracked() {
            return;
        }
        let event = {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            let current = inner.inline.as_ref().is_some_and(|i| {
                i.id == 0 && i.at == st.primary_head() && i.version == st.buffer.version()
            });
            if !current {
                return;
            }
            inner.last_inline_id += 1;
            let id = inner.last_inline_id;
            let at = st.primary_head();
            if let Some(i) = &mut inner.inline {
                i.id = id;
            }
            EditorInlineCompletionRequest {
                id,
                offset: utf16_offset(&st.buffer, at),
                position: st.position(at),
            }
        };
        self.cx.emit(EditorEvent::InlineCompletionRequest(event));
    }

    /// The app's answer to inline request `id`: its text shows at the
    /// caret, unless stale.
    pub(crate) fn present_inline_completion(&self, id: u32, text: String) {
        if text.is_empty() {
            self.hide_inline_completion();
            return;
        }
        {
            let st = self.st.borrow();
            let mut inner = self.completion.inner.borrow_mut();
            let shows = !self.completion.open.get_untracked();
            match &mut inner.inline {
                Some(i)
                    if i.id == id
                        && id != 0
                        && shows
                        && i.at == st.primary_head()
                        && i.version == st.buffer.version() =>
                {
                    i.text = Some(text)
                }
                _ => return,
            }
        }
        self.completion.ghost.set(true);
    }

    /// Clears the inline completion, shown or asked for.
    pub(crate) fn hide_inline_completion(&self) {
        let mut inner = self.completion.inner.borrow_mut();
        inner.inline = None;
        inner.inline_due = None;
        drop(inner);
        if self.completion.ghost.get_untracked() {
            self.completion.ghost.set(false);
        }
    }

    /// Tab: inserts the inline completion at the caret.
    fn accept_inline_completion(&self) {
        let found = {
            let inner = self.completion.inner.borrow();
            inner
                .inline
                .as_ref()
                .and_then(|i| Some((i.at, i.text.clone()?)))
        };
        self.hide_inline_completion();
        let Some((at, text)) = found else { return };
        self.insert_completion(vec![(at..at, text)]);
    }
}

/// The edits accepting an item makes: `range` (around the primary caret)
/// replaced with `text`, and the same at every other caret preceded by the
/// same text as the primary one, within its line.
fn completion_edits(st: &State, range: Range<usize>, text: &str) -> Vec<(Range<usize>, String)> {
    let caret = st.primary_head();
    let mut edits = vec![(range.clone(), text.to_owned())];
    let (before, after) = (
        caret.saturating_sub(range.start),
        range.end.saturating_sub(caret),
    );
    if range.start > caret {
        return edits;
    }
    let prefix = st.buffer.slice(range.start..caret);
    let primary = st.selections.primary_index();
    for (i, s) in st.selections.all().iter().enumerate() {
        if i == primary || !s.is_empty() || s.head < before {
            continue;
        }
        let start = s.head - before;
        let end = s.head + after;
        let line = st.buffer.line_of(s.head);
        if st.buffer.line_of(start) != line
            || end > st.buffer.line_end(line)
            || st.buffer.clip(start) != start
            || st.buffer.slice(start..s.head) != prefix
        {
            continue;
        }
        edits.push((start..end, text.to_owned()));
    }
    edits
}

/// Key options of the bindings while the editor's sink has the focus.
fn always() -> KeyOptions {
    KeyOptions {
        when: When::Always,
        repeat: false,
    }
}

// The view.

/// What the rows' box holds of completion: the list's anchor at the
/// query's start on the caret's row, and the inline completion's ghost
/// text at the caret.
pub(crate) fn marks(ed: Ed) -> impl IntoElement {
    let at = {
        let ed = ed.clone();
        computed(move || {
            // Only while the list shows: the anchor stays put as the caret
            // moves otherwise, so typing sends nothing for it.
            if !ed.completion.open.get() {
                return (Point::default(), px(0.0));
            }
            ed.completion.rev.get();
            ed.text_rev.get();
            ed.sel_rev.get();
            let st = ed.st.borrow();
            let caret = st.caret_point(st.primary_head());
            let start = ed
                .completion
                .inner
                .borrow()
                .session
                .as_ref()
                .map(|s| s.query_start);
            let x = match start {
                Some(start) => st.caret_point(start).x,
                None => caret.x,
            };
            (Point::new(x, caret.y), st.line_height())
        })
    };
    let anchor = view()
        .element_ref(&ed.completion.anchor)
        .absolute()
        .left(move || Length::from(at.get().0.x))
        .top(move || Length::from(at.get().0.y))
        .w(px(1.0))
        .h(move || Length::from(at.get().1))
        .pointer_events(PointerEvents::None);
    view()
        .absolute()
        .top_0()
        .left_0()
        .pointer_events(PointerEvents::None)
        .child(anchor)
        .child(ghost(ed))
}

/// The inline completion's text at the caret, muted: over the text after
/// the caret (on the editor's background) mid-line, its further lines on
/// the rows below.
fn ghost(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        if !ed.completion.ghost.get() {
            return Vec::new();
        }
        ed.text_rev.get();
        ed.sel_rev.get();
        let (text_, at, lh, mid_line) = {
            let st = ed.st.borrow();
            let inner = ed.completion.inner.borrow();
            let Some(text_) = inner.inline.as_ref().and_then(|i| i.text.clone()) else {
                return Vec::new();
            };
            let head = st.primary_head();
            let mid_line = head < st.buffer.line_end(st.buffer.line_of(head));
            (text_, st.caret_point(head), st.line_height(), mid_line)
        };
        let (first, rest) = match text_.split_once('\n') {
            Some((first, rest)) => (first.to_owned(), Some(rest.to_owned())),
            None => (text_, None),
        };
        let mut out = Vec::new();
        let line = text(first)
            .absolute()
            .left(Length::from(at.x))
            .top(Length::from(at.y))
            .h(Length::from(lh))
            .number_of_lines(1)
            .text_color(move || theme().muted_foreground)
            .when(mid_line || rest.is_some(), |t| {
                t.bg(move || theme().background)
            });
        out.push(parts(line, props, &[EditorPart::InlineCompletion]).into_element());
        if let Some(rest) = rest {
            let lines = text(rest)
                .absolute()
                .left_0()
                .top(Length::from(at.y + lh))
                .text_color(move || theme().muted_foreground)
                .bg(move || theme().background);
            out.push(parts(lines, props, &[EditorPart::InlineCompletion]).into_element());
        }
        out
    })
}

/// The list, in an overlay below the query's start (above it when there
/// is no room below), with the selected item's documentation beside it.
pub(crate) fn menu(ed: Ed) -> impl IntoElement {
    let open = ed.completion.open;
    when(
        move || open.get(),
        move || {
            let close = ed.clone();
            overlay()
                .anchor(&ed.completion.anchor)
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(2.0))
                .on_press_outside(move |_: &Point<Points>| close.hide_completions())
                .child(
                    view()
                        .flex_row()
                        .items_start()
                        .gap(px(4.0))
                        .child(list(ed.clone()))
                        .child(documentation(ed.clone())),
                )
        },
    )
}

/// The list's measures.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct ListSize {
    width: Points,
    /// The items the query matches.
    count: usize,
    /// A row's height.
    row: Points,
    /// The kind column's width, 0 without kinds.
    kind: Points,
}

/// The list's box: a scroll view of its rows, of which only those in view
/// are made.
fn list(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    let size = {
        let ed = ed.clone();
        computed(move || {
            ed.completion.rev.get();
            ed.text_rev.get();
            let st = ed.st.borrow();
            let mut inner = ed.completion.inner.borrow_mut();
            let css = st.font.css();
            let zero = match &inner.zero {
                Some((font, w)) if *font == css => *w,
                _ => {
                    let w = super::controller::text_width(&css, "0");
                    inner.zero = Some((css, w));
                    w
                }
            };
            let row = st.line_height();
            let Some(menu) = inner.session.as_ref().and_then(|s| s.menu.as_ref()) else {
                return ListSize {
                    row,
                    ..Default::default()
                };
            };
            // Monospaced: the widest label and detail make the width.
            let (mut label, mut detail) = (0, 0);
            for hit in menu.hits.iter().take(1000) {
                let item = &menu.items[hit.index];
                label = label.max(item.label.chars().count());
                let d = item.detail.as_ref().map_or(0, |d| d.chars().count());
                detail = detail.max(d.min(DETAIL_CHARS));
            }
            let kind = if menu.kinds { zero * 5.0 } else { px(0.0) };
            let gaps = [menu.kinds, detail > 0].iter().filter(|g| **g).count();
            let width = zero * (label + detail) as f32
                + kind
                + px(ROW_GAP) * gaps as f32
                + px(ROW_PADDING * 2.0 + 2.0);
            ListSize {
                width: width.max(px(160.0)).min(px(480.0)),
                count: menu.hits.len(),
                row,
                kind,
            }
        })
    };
    let ed2 = ed.clone();
    let list_y = ed.completion.list_y;
    let rows_list = ed.completion.list;
    parts(
        view()
            .w(move || Length::from(size.get().width))
            .bg(move || theme().popover)
            .text_color(move || theme().popover_foreground)
            .border_1()
            .border_color(move || theme().border)
            .rounded(move || Length::from((theme().radius - px(2.0)).max(px(0.0))))
            .shadow_md()
            .overflow_hidden(),
        props,
        &[EditorPart::CompletionMenu],
    )
    .child(
        scroll()
            .element_ref(&rows_list)
            .h(move || {
                let size = size.get();
                Length::from(size.row * size.count.min(VISIBLE_ROWS) as f32)
            })
            .on_scroll(move |e: &ScrollEvent| list_y.set(e.offset.y))
            .child(
                view()
                    .relative()
                    .h(move || {
                        let size = size.get();
                        Length::from(size.row * size.count as f32)
                    })
                    .child(dynamic(move || rows(ed2.clone(), size.get()))),
            ),
    )
}

/// The rows of the list in view, and a few more.
fn rows(ed: Ed, size: ListSize) -> Vec<AnyElement> {
    ed.completion.rev.get();
    let y = ed.completion.list_y.get();
    let h = size.row;
    let first = ((y.0 / h.0.max(1.0)).floor().max(0.0) as usize).saturating_sub(2);
    let inner = ed.completion.inner.borrow();
    let Some(menu) = inner.session.as_ref().and_then(|s| s.menu.as_ref()) else {
        return Vec::new();
    };
    let last = (first + VISIBLE_ROWS + 4).min(menu.hits.len());
    (first.min(last)..last)
        .map(|i| {
            let hit = &menu.hits[i];
            let item = &menu.items[hit.index];
            row(&ed, i, size, item, hit, i == menu.selected)
        })
        .collect()
}

/// Row `i` of the list.
fn row(
    ed: &Ed,
    i: usize,
    size: ListSize,
    item: &EditorCompletionItem,
    hit: &Hit,
    selected: bool,
) -> AnyElement {
    let h = size.row;
    let props = ed.props;
    let desktop = is_desktop();
    let (hover, down, tap) = (ed.clone(), ed.clone(), ed.clone());
    let mut el = view()
        .absolute()
        .left_0()
        .right_0()
        .top(Length::from(h * i as f32))
        .h(Length::from(h))
        .flex_row()
        .items_center()
        .gap(px(ROW_GAP))
        .px(px(ROW_PADDING))
        .focusable(false)
        .on_hover_in(move || hover.mark_completion(i))
        .on(EventKind::PressDown, move |_: &EventPayload| {
            if desktop {
                down.accept_completion(Some(i));
            }
        })
        .on_press(move || {
            if !desktop {
                tap.accept_completion(Some(i));
            }
        });
    if selected {
        el = el
            .bg(move || theme().accent)
            .text_color(move || theme().accent_foreground);
    }
    if size.kind.0 > 0.0 {
        let kind = item.kind.map_or("", EditorCompletionKind::short);
        el = el.child(parts(
            text(kind)
                .flex_none()
                .w(Length::from(size.kind))
                .number_of_lines(1)
                .text_color(move || theme().muted_foreground),
            props,
            &[EditorPart::CompletionKind],
        ));
    }
    let label = text("").flex_none().number_of_lines(1).children(
        runs(&item.label, &hit.highlights)
            .into_iter()
            .map(|(run, matched)| {
                let span = text(run.to_owned());
                if matched {
                    parts(
                        span.font_weight(FontWeight::SEMIBOLD)
                            .text_color(move || theme().primary),
                        props,
                        &[EditorPart::CompletionMatch],
                    )
                    .into_element()
                } else {
                    span.into_element()
                }
            })
            .collect::<Vec<_>>(),
    );
    el = el.child(label);
    if let Some(detail) = &item.detail {
        el = el.child(parts(
            text(detail.to_string())
                .flex_1()
                .min_w(px(0.0))
                .text_right()
                .number_of_lines(1)
                .text_color(move || theme().muted_foreground),
            props,
            &[EditorPart::CompletionDetail],
        ));
    }
    if selected {
        parts(
            el,
            props,
            &[
                EditorPart::CompletionItem,
                EditorPart::SelectedCompletionItem,
            ],
        )
        .into_element()
    } else {
        parts(el, props, &[EditorPart::CompletionItem]).into_element()
    }
}

/// The selected item's documentation, beside the list.
fn documentation(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.completion.rev.get();
        let doc = {
            let inner = ed.completion.inner.borrow();
            let menu = inner.session.as_ref().and_then(|s| s.menu.as_ref())?;
            let hit = menu.hits.get(menu.selected)?;
            menu.items[hit.index].documentation.clone()?
        };
        Some(parts(
            view()
                .max_w(px(DOCUMENTATION_WIDTH))
                .px(px(8.0))
                .py(px(6.0))
                .bg(move || theme().popover)
                .text_color(move || theme().popover_foreground)
                .border_1()
                .border_color(move || theme().border)
                .rounded(move || Length::from((theme().radius - px(2.0)).max(px(0.0))))
                .shadow_md()
                .child(text(doc.to_string())),
            props,
            &[EditorPart::CompletionDocumentation],
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str) -> EditorCompletionItem {
        EditorCompletionItem::new(label.to_string())
    }

    fn labels(items: &[EditorCompletionItem], query: &str) -> Vec<String> {
        filter(items, query)
            .into_iter()
            .map(|h| items[h.index].label.to_string())
            .collect()
    }

    #[test]
    fn fuzzy_matches_subsequences_in_any_case() {
        let f = fuzzy("file_loader", "fl").unwrap();
        // `fi` then `l` of `file`: the most compact match.
        assert_eq!(f.ranges, vec![0..1, 2..3]);
        assert_eq!(f.gaps, 1);
        assert_eq!(fuzzy("Flag", "fl").unwrap().ranges, vec![0..2]);
        assert!(fuzzy("flag", "fx").is_none());
        assert!(fuzzy("", "a").is_none());
        // The tightest of several matches.
        let f = fuzzy("axxbab", "ab").unwrap();
        assert_eq!((f.first, f.gaps), (4, 0));
        assert_eq!(f.ranges, vec![4..6]);
        // Multi-byte chars: byte ranges.
        assert_eq!(fuzzy("你好世界", "好世").unwrap().ranges, vec![3..9]);
    }

    #[test]
    fn prefix_matches_rank_first_then_compact_ones_then_sort_text() {
        let items = vec![
            item("toString"),
            item("trim"),
            item("String"),
            item("strip"),
            item("st"),
        ];
        // `st` is a prefix of `st`, `String` and `strip` (in any case),
        // those in its case first; `toString` matches later.
        assert_eq!(labels(&items, "st"), ["st", "strip", "String", "toString"]);
        // The query's case first.
        let items = [item("Receipt"), item("receipt")];
        assert_eq!(labels(&items, "rec"), ["receipt", "Receipt"]);
        assert_eq!(labels(&items, "Rec"), ["Receipt", "receipt"]);
        // `trim` does not match `st`.
        assert!(!labels(&items, "st").contains(&"trim".to_string()));
        // sortText orders equal matches.
        let mut a = item("alpha");
        a.sort_text = Some("2".into());
        let mut b = item("beta");
        b.sort_text = Some("1".into());
        assert_eq!(labels(&[a.clone(), b.clone()], ""), ["beta", "alpha"]);
        assert_eq!(labels(&[a, b], "a"), ["alpha", "beta"]);
    }

    #[test]
    fn filter_text_is_matched_and_the_label_highlighted() {
        let mut i = item("print(value)");
        i.filter_text = Some("print".into());
        let hits = filter(&[i], "pnt");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].highlights, vec![0..1, 3..5]);
        // An empty query keeps all, highlighting nothing.
        let hits = filter(&[item("a"), item("b")], "");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.highlights.is_empty()));
    }

    #[test]
    fn runs_cut_a_label_at_its_highlights() {
        assert_eq!(
            runs("file_loader", &[0..1, 2..3]),
            vec![("f", true), ("i", false), ("l", true), ("e_loader", false)]
        );
        assert_eq!(runs("abc", &[]), vec![("abc", false)]);
        assert_eq!(
            runs("abc", std::slice::from_ref(&(0..3))),
            vec![("abc", true)]
        );
    }

    fn state(text: &str) -> State {
        use super::super::{commands::EditOptions, language, state::Font};
        let font = Font {
            family: "monospace".into(),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|text: &str| px(10.0 * text.chars().count() as f32));
        State::new(
            text,
            language::language("typescript"),
            EditOptions::default(),
            font,
            measure,
        )
    }

    fn caret(st: &mut State, at: usize) {
        use super::super::types::{Selection, Selections};
        st.selections = Selections::single(Selection::caret(at));
    }

    #[test]
    fn a_session_holds_while_the_caret_stays_in_its_word() {
        let mut st = state("let $foo = a.bar\nx");
        // The language's word chars count (`$` in TypeScript).
        assert_eq!(word_start(&st, 8), 4);
        caret(&mut st, 8);
        assert!(holds(&st, 4));
        // Left of the start, across a non-word char, on another line.
        caret(&mut st, 3);
        assert!(!holds(&st, 4));
        caret(&mut st, 12);
        assert!(!holds(&st, 4));
        caret(&mut st, 18);
        assert!(!holds(&st, 4));
        // After a trigger character the word starts after it.
        assert_eq!(word_start(&st, 16), 13);
        caret(&mut st, 16);
        assert!(holds(&st, 13));
    }

    #[test]
    fn accepting_at_several_carets_replaces_where_the_prefix_matches() {
        use super::super::types::{Selection, Selections};
        let mut st = state("fo\nfo\nba\n");
        st.selections = Selections::new(
            vec![
                Selection::caret(2),
                Selection::caret(5),
                Selection::caret(8),
            ],
            0,
        );
        let edits = completion_edits(&st, 0..2, "foo");
        assert_eq!(
            edits,
            vec![(0..2, "foo".to_string()), (3..5, "foo".to_string())]
        );
    }
}
