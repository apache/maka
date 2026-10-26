//! Find and replace: the matches of an [`EditorSearch`] in the text, what
//! replaces each, and stepping from one match to the next.
//!
//! A plain query is escaped into a regular expression, so both kinds run on
//! `regex`: its case-insensitive matching folds Unicode case (`É` finds `é`,
//! `Σ` finds `ς`), and it runs in linear time whatever the app's query is.
//! `^` and `$` match at every line's start and end, as editors' searches do.

use std::ops::Range;

use regex::{Regex, RegexBuilder};

use super::{buffer::Buffer, data::EditorSearch};

/// Every match of `search` (at most `limit`); Err with the regex error for an
/// invalid regular expression. An empty query finds nothing. A regular
/// expression may match empty ranges (`^` finds every line's start, so a
/// replacement can prefix lines), never two at one offset.
pub(crate) fn find_all(
    buffer: &Buffer,
    search: &EditorSearch,
    limit: usize,
) -> Result<Vec<Range<usize>>, String> {
    let Some(regex) = compile(search)? else {
        return Ok(Vec::new());
    };
    let text = buffer.text();
    Ok(matches(&regex, &text, search.whole_word, limit))
}

/// The text replacing match `range` (`$1`, `${name}` expanded for regexes;
/// `$$` is a `$`). A plain query's replacement is `with` as written.
pub(crate) fn replacement(
    buffer: &Buffer,
    range: Range<usize>,
    search: &EditorSearch,
    with: &str,
) -> String {
    if !search.regex {
        return with.to_owned();
    }
    let Ok(Some(regex)) = compile(search) else {
        return with.to_owned();
    };
    // The lines the match is on are all the context `^`, `$` and `\b` look
    // at (lines end at '\n'), so the regex sees what it saw in the whole text
    // without building it again for every replacement.
    let start = buffer.line_start(buffer.line_of(range.start));
    let end = buffer.line_end(buffer.line_of(range.end));
    let context = buffer.slice(start..end.max(range.end));
    expand(&regex, &context, range.start - start, with)
}

/// What replacing every match of `search` with `with` does (at most `limit`
/// matches): the edits, sorted and apart, for one undo step. Builds the text
/// once, where calling [`replacement`] per match would read its lines each
/// time.
#[cfg(test)]
pub(crate) fn replace_all(
    buffer: &Buffer,
    search: &EditorSearch,
    with: &str,
    limit: usize,
) -> Result<Vec<(Range<usize>, String)>, String> {
    let Some(regex) = compile(search)? else {
        return Ok(Vec::new());
    };
    let text = buffer.text();
    let found = matches(&regex, &text, search.whole_word, limit);
    Ok(found
        .into_iter()
        .map(|range| {
            let replaced = if search.regex {
                expand(&regex, &text, range.start, with)
            } else {
                with.to_owned()
            };
            (range, replaced)
        })
        .collect())
}

/// The index of the first match at or after `offset` (wrapping to 0).
/// `matches` are sorted, as [`find_all`] returns them.
pub(crate) fn next_match(matches: &[Range<usize>], offset: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    let index = matches.partition_point(|m| m.start < offset);
    Some(if index == matches.len() { 0 } else { index })
}

/// The index of the last match starting before `offset` (wrapping to the
/// last one).
pub(crate) fn previous_match(matches: &[Range<usize>], offset: usize) -> Option<usize> {
    if matches.is_empty() {
        return None;
    }
    let index = matches.partition_point(|m| m.start < offset);
    Some(if index == 0 {
        matches.len() - 1
    } else {
        index - 1
    })
}

/// The matches that lie inside one of `scope`'s ranges (a search in the
/// selection): both kinds sorted, as [`find_all`] returns matches.
pub(crate) fn within<'a>(
    matches: Vec<Range<usize>>,
    scope: impl IntoIterator<Item = &'a Range<usize>>,
) -> Vec<Range<usize>> {
    let mut scope: Vec<&Range<usize>> = scope.into_iter().collect();
    scope.sort_by_key(|r| (r.start, r.end));
    matches
        .into_iter()
        .filter(|m| {
            // The last scope starting at or before the match is the only one
            // that can hold it, unless scopes overlap: check those before it
            // that still reach the match's end.
            let index = scope.partition_point(|r| r.start <= m.start);
            scope[..index].iter().rev().any(|r| m.end <= r.end)
        })
        .collect()
}

/// The regular expression `search` runs; None for an empty query.
fn compile(search: &EditorSearch) -> Result<Option<Regex>, String> {
    let query = search.query.as_str();
    if query.is_empty() {
        return Ok(None);
    }
    let pattern = if search.regex {
        query.to_owned()
    } else {
        // The text's lines end with '\n' only: a pasted "\r\n" still finds
        // the line breaks it was copied from.
        regex::escape(&query.replace("\r\n", "\n").replace('\r', "\n"))
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!search.case_sensitive)
        .multi_line(true)
        .build()
        .map(Some)
        .map_err(|error| error.to_string())
}

/// The matches of `regex` in `text`, sorted; with `whole_word` only those
/// whose ends are word boundaries.
fn matches(regex: &Regex, text: &str, whole_word: bool, limit: usize) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let mut at = 0;
    // Where the last match ended: an empty match right there is the empty
    // rest of that match, not one of its own (as `find_iter` skips it).
    let mut last_end = None;
    while at <= text.len() && found.len() < limit {
        let Some(m) = regex.find_at(text, at) else {
            break;
        };
        let range = m.range();
        let accepted = !(range.is_empty() && last_end == Some(range.start))
            && (!whole_word || is_whole_word(text, &range));
        if accepted {
            last_end = Some(range.end);
            found.push(range.clone());
            at = if range.is_empty() {
                next_char(text, range.end)
            } else {
                range.end
            };
        } else {
            // A rejected match may hide one starting inside it (`ab` in
            // "xab ab" for the word "ab"): try again one char further.
            at = next_char(text, range.start);
        }
    }
    found
}

/// Whether `range` starts and ends at a word boundary: a non-word char (or
/// the text's edge) on at least one side of each end, so a query starting or
/// ending with punctuation (`.len`, `foo(`) still finds whole-word matches.
fn is_whole_word(text: &str, range: &Range<usize>) -> bool {
    let before = text[..range.start].chars().next_back();
    let first = text[range.start..range.end].chars().next();
    let last = text[range.start..range.end].chars().next_back();
    let after = text[range.end..].chars().next();
    let left = !before.is_some_and(is_word) || !first.is_some_and(is_word);
    let right = !after.is_some_and(is_word) || !last.is_some_and(is_word);
    left && right
}

/// A word character, for every language: letters, digits and `_`.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The offset after the char at `offset` (past the text's end at its end).
fn next_char(text: &str, offset: usize) -> usize {
    text[offset..]
        .chars()
        .next()
        .map_or(offset + 1, |c| offset + c.len_utf8())
}

/// `with` expanded with the captures of the match of `regex` at `start` of
/// `text`; `with` as written when the regex no longer matches there.
fn expand(regex: &Regex, text: &str, start: usize, with: &str) -> String {
    match regex.captures_at(text, start) {
        Some(captures) if captures.get(0).is_some_and(|m| m.start() == start) => {
            let mut out = String::new();
            captures.expand(with, &mut out);
            out
        }
        _ => with.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search(query: &str) -> EditorSearch {
        EditorSearch::new(query.to_owned())
    }

    fn find(text: &str, search: &EditorSearch) -> Vec<Range<usize>> {
        find_all(&Buffer::new(text), search, usize::MAX).unwrap()
    }

    /// The texts matched (in a text without '\r', whose offsets the
    /// buffer keeps).
    fn found<'a>(text: &'a str, search: &EditorSearch) -> Vec<&'a str> {
        find(text, search).into_iter().map(|r| &text[r]).collect()
    }

    #[test]
    fn empty_query_and_empty_text_find_nothing() {
        assert!(find("abc", &search("")).is_empty());
        assert!(find("", &search("a")).is_empty());
        let mut regex = search("");
        regex.regex = true;
        assert!(find("abc", &regex).is_empty());
    }

    #[test]
    fn plain_queries_are_literal_and_ignore_case() {
        assert_eq!(find("a.b aXb A.B", &search("a.b")), vec![0..3, 8..11]);
        assert_eq!(
            found("Foo foo FOO", &search("foo")),
            vec!["Foo", "foo", "FOO"]
        );
        let mut sensitive = search("foo");
        sensitive.case_sensitive = true;
        assert_eq!(find("Foo foo FOO", &sensitive), vec![4..7]);
        assert_eq!(find("(a+b)*", &search("(a+b)")), vec![0..5]);
        assert_eq!(find("$1 $1", &search("$1")), vec![0..2, 3..5]);
    }

    #[test]
    fn case_folding_is_unicode() {
        assert_eq!(
            found("École école ÉCOLE", &search("école")),
            vec!["École", "école", "ÉCOLE"]
        );
        // Σ, σ and the final ς fold together.
        assert_eq!(found("ΣΊΣΥΦΟΣ σίσυφος", &search("σίσυφοσ")).len(), 2);
        assert_eq!(found("Straße STRASSE", &search("straße")), vec!["Straße"]);
    }

    #[test]
    fn multibyte_offsets_are_byte_offsets() {
        let text = "你好，世界。世界！";
        let ranges = find(text, &search("世界"));
        assert_eq!(ranges, vec![9..15, 18..24]);
        assert_eq!(&text[ranges[1].clone()], "世界");
        let emoji = "👋🏽 hi 👋🏽";
        assert_eq!(find(emoji, &search("👋🏽")), vec![0..8, 12..20]);
    }

    #[test]
    fn whole_words() {
        let mut word = search("ab");
        word.whole_word = true;
        assert_eq!(find("ab xab abx ab_ ab", &word), vec![0..2, 15..17]);
        // A rejected match does not hide one starting inside it.
        let mut aa = search("aa");
        aa.whole_word = true;
        assert_eq!(find("aaa aa", &aa), vec![4..6]);
        // Ends that are punctuation are boundaries themselves.
        let mut dot = search(".len");
        dot.whole_word = true;
        assert_eq!(find("s.len() s.length", &dot), vec![1..5]);
        // Letters of any script are word chars.
        let mut cjk = search("世界");
        cjk.whole_word = true;
        assert!(find("你好世界", &cjk).is_empty());
        assert_eq!(find("你好 世界", &cjk), vec![7..13]);
        let mut e = search("é");
        e.whole_word = true;
        assert_eq!(find("café é", &e), vec![6..8]);
    }

    #[test]
    fn regexes_and_their_errors() {
        let mut digits = search(r"\d+");
        digits.regex = true;
        assert_eq!(found("a1 b22\nc333", &digits), vec!["1", "22", "333"]);
        let mut bad = search("(a");
        bad.regex = true;
        assert!(find_all(&Buffer::new("a"), &bad, 10).is_err());
        let mut lines = search("^\\w+$");
        lines.regex = true;
        assert_eq!(found("one\ntwo three\nfour", &lines), vec!["one", "four"]);
        let mut insensitive = search("[a-z]+");
        insensitive.regex = true;
        assert_eq!(found("ABC", &insensitive), vec!["ABC"]);
    }

    #[test]
    fn empty_regex_matches_once_per_offset() {
        let mut starts = search("^");
        starts.regex = true;
        assert_eq!(find("a\nb\n", &starts), vec![0..0, 2..2, 4..4]);
        let mut stars = search("a*");
        stars.regex = true;
        assert_eq!(find("aab", &stars), vec![0..2, 3..3]);
        // Empty matches step over multibyte chars.
        let mut empty = search("x*");
        empty.regex = true;
        assert_eq!(find("é", &empty), vec![0..0, 2..2]);
    }

    #[test]
    fn limits_and_line_breaks() {
        assert_eq!(
            find_all(&Buffer::new("aaaa"), &search("a"), 2).unwrap(),
            vec![0..1, 1..2]
        );
        // The buffer's "\r\n" are '\n'; a query with "\r\n" still finds them.
        assert_eq!(find("a\r\nb\r\n", &search("a\r\nb")), vec![0..3]);
        assert_eq!(find("tab\there", &search("\t")), vec![3..4]);
        assert_eq!(find("end", &search("end")), vec![0..3]);
    }

    #[test]
    fn replacements() {
        let buffer = Buffer::new("let a = 1;\nlet bb = 22;");
        let mut assign = search(r"let (?P<name>\w+) = (\d+)");
        assign.regex = true;
        let matches = find_all(&buffer, &assign, 10).unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(
            replacement(
                &buffer,
                matches[1].clone(),
                &assign,
                "const ${name}: i32 = $2 $$"
            ),
            "const bb: i32 = 22 $"
        );
        let plain = search("a");
        assert_eq!(replacement(&buffer, 4..5, &plain, "$1"), "$1");
        let edits = replace_all(&buffer, &assign, "${name}=$2", 10).unwrap();
        assert_eq!(
            edits,
            vec![(0..9, "a=1".to_owned()), (11..22, "bb=22".to_owned())]
        );
    }

    #[test]
    fn replacement_sees_the_line_around_the_match() {
        let buffer = Buffer::new("xfoo\nfoo bar");
        let mut start = search("^(foo)");
        start.regex = true;
        let matches = find_all(&buffer, &start, 10).unwrap();
        assert_eq!(matches, vec![5..8]);
        assert_eq!(replacement(&buffer, 5..8, &start, "[$1]"), "[foo]");
        // A range the regex does not match (the text changed) keeps `with`.
        assert_eq!(replacement(&buffer, 1..4, &start, "[$1]"), "[$1]");
        let mut prefix = search("^");
        prefix.regex = true;
        let edits = replace_all(&buffer, &prefix, "// ", 10).unwrap();
        assert_eq!(
            edits,
            vec![(0..0, "// ".to_owned()), (5..5, "// ".to_owned())]
        );
    }

    #[test]
    fn stepping_wraps() {
        let matches = vec![2..4, 6..8, 10..12];
        assert_eq!(next_match(&matches, 0), Some(0));
        assert_eq!(next_match(&matches, 2), Some(0));
        assert_eq!(next_match(&matches, 3), Some(1));
        assert_eq!(next_match(&matches, 11), Some(0));
        assert_eq!(previous_match(&matches, 6), Some(0));
        assert_eq!(previous_match(&matches, 7), Some(1));
        assert_eq!(previous_match(&matches, 2), Some(2));
        assert_eq!(previous_match(&matches, 100), Some(2));
        assert_eq!(next_match(&[], 0), None);
        assert_eq!(previous_match(&[], 0), None);
    }

    #[test]
    fn matches_within_a_scope() {
        let matches = vec![0..2, 3..5, 6..8, 9..9, 10..12];
        let scope = [9..12, 2..6];
        assert_eq!(within(matches.clone(), &scope), vec![3..5, 9..9, 10..12]);
        assert_eq!(within(matches, &[]), Vec::<Range<usize>>::new());
    }
}
