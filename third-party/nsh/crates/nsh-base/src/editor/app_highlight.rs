//! The app's highlighting: decorations with a `token` color their text as
//! the built-in highlighter colors that kind of token, in place of what
//! the highlighter found there (`Highlighter::tokens`, which this leaves
//! alone), their `class` / `style` over it. And the lookup of a row's
//! decorations among many (semantic tokens are thousands of short ones).

use std::ops::Range;

use super::{EditorDecoration, diagnostics::Mark};
use crate::syntax::Token;

/// The bytes of the longest of `marks`: how far before a row a decoration
/// over it can start.
pub(crate) fn reach<T>(marks: &[Mark<T>]) -> usize {
    marks.iter().map(|m| m.range.len()).max().unwrap_or(0)
}

/// The decorations of `marks` (with their indexes) that can overlap bytes
/// `low..=high`: those starting at most `reach` bytes before `low`, up to
/// `high`. Marks are sorted by start, so this is two binary searches,
/// however many there are. Diagnostics are looked up alike (their tags).
pub(crate) fn near<T>(
    marks: &[Mark<T>],
    reach: usize,
    low: usize,
    high: usize,
) -> impl Iterator<Item = (usize, &Mark<T>)> {
    let from = marks.partition_point(|m| m.range.start.saturating_add(reach) < low);
    let to = marks.partition_point(|m| m.range.start <= high).max(from);
    marks[from..to]
        .iter()
        .enumerate()
        .map(move |(k, m)| (from + k, m))
}

/// The app's token over `span` (buffer bytes): the innermost decoration's
/// among `over` (indexes into `marks` with their ranges, by start) that
/// covers it and has one.
pub(crate) fn token(
    over: &[(usize, Range<usize>)],
    marks: &[Mark<usize>],
    items: &[EditorDecoration],
    span: Range<usize>,
) -> Option<Token> {
    // By start, an inner decoration comes after the ones around it.
    over.iter()
        .rev()
        .filter(|(_, r)| r.start <= span.start && r.end >= span.end)
        .find_map(|(i, _)| items.get(marks[*i].item).and_then(|d| d.token))
        .map(|t| t.syntax())
}
