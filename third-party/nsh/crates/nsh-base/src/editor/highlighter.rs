//! The highlighters an app brings: what an embedding app or an app's crate
//! implements to highlight a language its own way (tree-sitter, a syntax
//! of its own), on the editor's one highlighting pipeline
//! (`highlight.rs`): the built-in highlighter is one of them.
//!
//! The pipeline keeps the tokens on the engine thread and hands the
//! highlighter off it, with a snapshot of the text and a time budget, up
//! to the lines in view and past them; it keeps every line's tokens until
//! the highlighter gives the line new ones (moved with the text over
//! edits, typed text in the token it extends), and asks again while lines
//! are not current. A highlighter only says what changed and what it
//! found.

use std::{ops::Range, time::Duration};

use ropey::Rope;

use super::{EditorToken, highlight::Tokens};

/// Highlights an editor's text (or a `DiffView` side's): an app's own
/// highlighter for a language ([`register_highlighter`]), as the
/// built-in one highlights the built-in languages.
///
/// It runs off the engine thread ([`Send`]): the editor gives it the
/// text's edits as they happen and asks it to highlight on, within a time
/// budget, until the lines up to the last one asked for are current. It
/// gives each line it highlights its tokens; a line it does not give
/// tokens again keeps the ones it had, moved with the text. An
/// incremental highlighter (tree-sitter) reparses from the edits and
/// gives the lines whose tokens changed; a line-by-line one parses on from
/// the first edited line until its state at a line's start is what it was
/// before.
///
/// [`register_highlighter`]: super::register_highlighter
pub trait EditorHighlighter: Send + 'static {
    /// The text changed as `edit` says. The lines from
    /// `edit.first_line` on are not current until the highlighter gives
    /// them tokens again (or knows they are what they were). A new
    /// highlighter is told of the whole text as one edit, from an empty
    /// text.
    fn edited(&mut self, edit: &EditorTextEdit);

    /// Highlights on: the lines that are not current up to `last_line`
    /// (inclusive; past the text's last line means to the end), in order,
    /// for about `budget` (at least one line a call), giving each line's
    /// tokens to `tokens`. Returns whether every line up to `last_line`
    /// is current; the editor calls again while it is not.
    fn highlight(
        &mut self,
        text: &EditorText,
        last_line: usize,
        budget: Duration,
        tokens: &mut EditorTokens,
    ) -> bool;

    /// The first line that is not current: the lines before it are. The
    /// editor guesses the lines in view when they are far past it
    /// ([`EditorHighlighter::guess`]).
    fn frontier(&self) -> usize;

    /// Highlights lines `first_line..=last_line` as if the text started
    /// at line `first_line` (at byte `offset`), giving their tokens to
    /// `tokens`: what the lines in view show while the highlighting from
    /// the text's start has not reached them (a jump to the end of a long
    /// file). Called on a new highlighter of the language, made for the
    /// guess. Returns false for a highlighter that does not guess (the
    /// default): the editor then waits for [`EditorHighlighter::highlight`].
    fn guess(
        &mut self,
        text: &EditorText,
        first_line: usize,
        offset: usize,
        last_line: usize,
        tokens: &mut EditorTokens,
    ) -> bool {
        let _ = (text, first_line, offset, last_line, tokens);
        false
    }
}

/// The text a highlighter reads: a snapshot of the editor's text, cheap
/// to clone. Its lines end at `\n` only (the editor's line breaks are
/// normalized to it).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct EditorText {
    rope: Rope,
}

impl EditorText {
    pub(crate) fn new(rope: Rope) -> EditorText {
        EditorText { rope }
    }

    /// The text as a rope (for a parser that reads chunks: tree-sitter's
    /// `parse_with`).
    pub fn rope(&self) -> &Rope {
        &self.rope
    }

    /// Its length in bytes.
    pub fn len(&self) -> usize {
        self.rope.len_bytes()
    }

    /// Whether it is empty.
    pub fn is_empty(&self) -> bool {
        self.rope.len_bytes() == 0
    }

    /// Reads the line that starts at byte `offset` into `line` (cleared
    /// first), with its line break; returns whether it has one (the text's
    /// last line has none).
    pub fn read_line(&self, offset: usize, line: &mut String) -> bool {
        line.clear();
        if offset >= self.rope.len_bytes() {
            return false;
        }
        let (chunks, chunk_start, _, _) = self.rope.chunks_at_byte(offset);
        let mut skip = offset - chunk_start;
        for chunk in chunks {
            let chunk = &chunk[skip..];
            skip = 0;
            if let Some(end) = chunk.find('\n') {
                line.push_str(&chunk[..=end]);
                return true;
            }
            line.push_str(chunk);
        }
        false
    }
}

/// A place in an editor's text: a line (from 0) and a byte offset in it,
/// as tree-sitter's `Point` counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub struct EditorTextPoint {
    /// The line, from 0.
    pub line: usize,
    /// The bytes before it on its line.
    pub column: usize,
}

impl EditorTextPoint {
    /// Byte `column` of line `line`.
    pub fn new(line: usize, column: usize) -> EditorTextPoint {
        EditorTextPoint { line, column }
    }
}

/// How the text changed, for a highlighter ([`EditorHighlighter::edited`]):
/// lines `first_line..first_line + old_line_count` became
/// `first_line..first_line + new_line_count`, and bytes
/// `start_byte..old_end_byte` became `start_byte..new_end_byte`, with
/// their places: the shape of tree-sitter's `InputEdit`. Several changes
/// made at once (typing at several carets) come as one edit over the
/// lines they touched. A new text comes as every line changed (as many
/// lines before as after), its bytes and places the whole old and new
/// texts'.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct EditorTextEdit {
    /// The first line changed, the same before and after.
    pub first_line: usize,
    /// How many lines the change spanned before.
    pub old_line_count: usize,
    /// How many lines it spans now.
    pub new_line_count: usize,
    /// Where the change starts, the same before and after.
    pub start_byte: usize,
    /// Where it ended before.
    pub old_end_byte: usize,
    /// Where it ends now.
    pub new_end_byte: usize,
    /// The place of `start_byte`.
    pub start: EditorTextPoint,
    /// The place of `old_end_byte` in the text before.
    pub old_end: EditorTextPoint,
    /// The place of `new_end_byte`.
    pub new_end: EditorTextPoint,
}

impl EditorTextEdit {
    /// An edit of lines only (no bytes or places): what a line-by-line
    /// highlighter reads, for its tests.
    pub fn lines(first_line: usize, old_line_count: usize, new_line_count: usize) -> Self {
        EditorTextEdit {
            first_line,
            old_line_count,
            new_line_count,
            ..EditorTextEdit::default()
        }
    }
}

/// Where a highlighter puts the tokens it found
/// ([`EditorHighlighter::highlight`]): by line, each line's at once.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct EditorTokens {
    pub(crate) lines: Vec<(usize, Tokens)>,
}

impl EditorTokens {
    /// Line `line`'s tokens, replacing what it had: byte ranges within the
    /// line (without its line break), on character boundaries, by start,
    /// and their kinds (colored as the built-in highlighting colors them).
    /// Empty ranges and the parts of a range before the end of the one
    /// before it are dropped; touching ranges of one kind join. Text
    /// between tokens is plain.
    pub fn line(
        &mut self,
        line: usize,
        tokens: impl IntoIterator<Item = (Range<usize>, EditorToken)>,
    ) {
        let mut out: Tokens = Vec::new();
        for (range, token) in tokens {
            let token = token.syntax();
            let start = range.start.max(out.last().map_or(0, |(r, _)| r.end));
            if start >= range.end {
                continue;
            }
            match out.last_mut() {
                Some((last, kind)) if last.end == start && *kind == token => last.end = range.end,
                _ => out.push((start..range.end, token)),
            }
        }
        self.lines.push((line, out));
    }

    /// How many lines were given tokens.
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// Whether no line was given tokens.
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// Line `line`'s tokens as the built-in highlighter found them.
    #[cfg_attr(not(feature = "highlight"), allow(dead_code))]
    pub(crate) fn push(&mut self, line: usize, tokens: Tokens) {
        self.lines.push((line, tokens));
    }
}

impl EditorToken {
    /// The kind of token a scope or capture name names: tree-sitter's
    /// highlight captures (`keyword`, `function.method`, `type.builtin`,
    /// `string.special`, `comment.documentation`, `property`, ...) and
    /// TextMate scopes (`keyword.control.rust`, `entity.name.function`,
    /// `string.quoted.double`). `None` for what keeps the text's own
    /// color: variables, punctuation, operators.
    pub fn from_scope(scope: &str) -> Option<EditorToken> {
        let scope = scope.trim_start_matches('@');
        let is = |prefix: &str| {
            scope
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
        };
        let any = |prefixes: &[&str]| prefixes.iter().any(|p| is(p));
        Some(if any(&["comment"]) {
            EditorToken::Comment
        } else if any(&[
            "string",
            "character",
            "escape",
            "regexp",
            "constant.character.escape",
            "markup.inserted",
            "diff.plus",
        ]) {
            EditorToken::String
        } else if any(&["markup.deleted", "diff.minus"]) {
            EditorToken::Deletion
        } else if any(&[
            "variable.builtin",
            "variable.parameter",
            "variable.member",
            "variable.other.member",
            "variable.other.property",
            "variable.language",
            "parameter",
            "property",
            "field",
            "attribute",
            "label",
            "key",
            "entity.other.attribute-name",
            "support.type.property-name",
            "tag.attribute",
        ]) {
            EditorToken::Attr
        } else if any(&["number", "float", "boolean", "constant"]) {
            EditorToken::Number
        } else if any(&[
            "function.builtin",
            "function.macro",
            "type",
            "tag",
            "support.function.builtin",
            "support.macro",
            "support.type",
            "entity.name.tag",
        ]) {
            EditorToken::Built
        } else if any(&[
            "function",
            "method",
            "constructor",
            "module",
            "namespace",
            "title",
            "support.function",
            "support.class",
            "entity.name",
            "entity.other.inherited-class",
        ]) {
            EditorToken::Title
        } else if any(&[
            "keyword",
            "storage",
            "conditional",
            "repeat",
            "include",
            "exception",
            "markup.heading",
        ]) {
            EditorToken::Keyword
        } else {
            return None;
        })
    }
}
