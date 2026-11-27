//! Where soft-wrapped text may break, shared by the editor's rows and the
//! diff view's wrapped lines so both wrap alike: between two ASCII chars
//! after whitespace (code wraps between its tokens; an operator such as
//! `->` or a path stays whole), next to any other char where Unicode's line
//! breaking (UAX #14) allows, and never inside a grapheme.

use unicode_segmentation::GraphemeCursor;

/// How far before a row UAX #14 may look for context.
const BREAK_CONTEXT: usize = 64;

/// The last break opportunity of plain text (no label in it) after `floor`
/// and before `bound` (at it too when `inclusive`), the text's context
/// starting at `context` at the earliest. UAX #14 runs backwards from
/// `bound` a span at a time, each from where its breaks no longer depend on
/// the text before it (`split_at_safe`): a few chars, not the whole line. A
/// span starts a char before that point (so it can break there), but that
/// char lacks its own context (a combining mark, its base's class): a break
/// before the point is the next span's to decide. Nothing looks further
/// back than [`BREAK_CONTEXT`] bytes before the row (from `row_start`), so
/// a line wraps in time linear in its length; text without such a point
/// that long (a rare run, as of spaces with combining marks) takes its
/// breaks as if the line started there.
pub(crate) fn text_break(
    text: &str,
    row_start: usize,
    context: usize,
    floor: usize,
    bound: usize,
    inclusive: bool,
) -> Option<usize> {
    let bytes = text.as_bytes();
    let ascii_pair = |offset: usize| bytes[offset - 1].is_ascii() && bytes[offset].is_ascii();
    let mut context = row_start.saturating_sub(BREAK_CONTEXT).max(context);
    while !text.is_char_boundary(context) {
        context -= 1;
    }
    // A row starts at a grapheme boundary: graphemes are found from there.
    let row = &text[row_start..];
    // Opportunities after `start`, up to `max`, are looked for; `bound` is
    // a char's offset, and the span ends after that char, so it decides
    // the break before it.
    let mut bound = bound;
    let mut max = if inclusive { bound } else { bound - 1 };
    let lowest = floor.max(context);
    loop {
        // Between ASCII chars a row breaks only after whitespace, whatever
        // comes before: a run of them (a Latin word, a URL) is scanned as
        // bytes, not a span at a time.
        let top = max;
        while max > lowest && ascii_pair(max) {
            // After a run of whitespace, never inside one: the run hangs
            // past the edge rather than starting the next row.
            if char::from(bytes[max - 1]).is_whitespace() && !char::from(bytes[max]).is_whitespace()
            {
                return Some(max);
            }
            max -= 1;
        }
        if max <= lowest {
            return None;
        }
        if max < top {
            // The run ended at an ASCII char (a char boundary) after
            // another char: UAX #14 decides the break before it.
            bound = max;
        }
        let end = bound + text[bound..].chars().next().map_or(0, char::len_utf8);
        let (before, span) = unicode_linebreak::split_at_safe(&text[context..end]);
        let span_start = context + before.len();
        let start = if before.is_empty() {
            span_start
        } else {
            span_start + span.chars().next().map_or(0, char::len_utf8)
        };
        let mut found = None;
        for (offset, _) in unicode_linebreak::linebreaks(span) {
            let offset = span_start + offset;
            if offset > max {
                break;
            }
            if offset > start
                && offset > floor
                && !ascii_pair(offset)
                && is_grapheme_boundary(row, offset - row_start)
            {
                found = Some(offset);
            }
        }
        // Between ASCII chars (always a grapheme boundary: no `\r\n` in a
        // line), after whitespace: after a run of it, never inside one.
        if let Some(offset) = (start.max(floor) + 1..=max).rev().find(|&offset| {
            ascii_pair(offset)
                && char::from(bytes[offset - 1]).is_whitespace()
                && !char::from(bytes[offset]).is_whitespace()
        }) {
            found = found.max(Some(offset));
        }
        // A span from `context` on is as far back as the text goes.
        if found.is_some() || start <= floor || before.is_empty() {
            return found;
        }
        bound = start;
        max = start;
    }
}

/// Whether `offset` (a char boundary after the first char) of `text` is a
/// grapheme boundary: the next one after the char before it. Asked as
/// `next_boundary`, which the grapheme walk calls too: a second caller of
/// `is_boundary` stops the optimizer inlining it into that walk, which then
/// costs every non-ASCII line.
fn is_grapheme_boundary(text: &str, offset: usize) -> bool {
    let before = text[..offset].chars().next_back().map_or(0, char::len_utf8);
    GraphemeCursor::new(offset - before, text.len(), true).next_boundary(text, 0)
        == Ok(Some(offset))
}
