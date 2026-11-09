//! Bare URLs (GitHub's autolink literals: `https://…`, `www.…`) ending
//! where Chinese, Japanese or Korean text starts. A literal runs to the next
//! whitespace, and CJK text puts no space after a URL: `https://example.com。
//! 下一句` would link `。下一句` too. A URL ends before the first CJK
//! character (full-width punctuation included, as the CJK-friendly
//! amendment to CommonMark defines them, `cjk::is_cjk`) or curly quotation
//! mark (`‘’“”`, which CJK text quotes with) after its start: [`END`], a
//! whitespace character, is placed there before parsing, so the parser
//! ends the literal (and trims its trailing punctuation) as at a space, and
//! `offsets.rs` takes it out of the tree after parsing. A URL written in
//! angle brackets (`<https://…>`) or as a link's destination keeps
//! every character.

use std::borrow::Cow;

use super::cjk::is_cjk;

/// What is placed where a URL ends: NEL, whitespace to the parser and a
/// control character no text uses. One in the source is removed with the
/// ones placed.
pub(super) const END: char = '\u{85}';

/// `source` with [`END`] where its bare URLs meet CJK text; where each went
/// (offsets in `source`, in order) is pushed to `at`.
pub(super) fn end_urls<'s>(source: &'s str, at: &mut Vec<usize>) -> Cow<'s, str> {
    if source.is_ascii() {
        return Cow::Borrowed(source);
    }
    let bytes = source.as_bytes();
    let first = at.len();
    let mut i = 0;
    while i < bytes.len() {
        // A prefix starts with an ASCII letter, so `i` is at a character.
        let prefix = match bytes[i] {
            b'h' | b'H' | b'w' | b'W' => url_start(source, i),
            _ => None,
        };
        let Some(prefix) = prefix else {
            i += 1;
            continue;
        };
        i += prefix;
        // To the whitespace (or `<`) that ends the literal anyway.
        let rest = &source[i..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '<' || stops_url(c))
            .unwrap_or(rest.len());
        if rest[end..].chars().next().is_some_and(stops_url) {
            at.push(i + end);
        }
        i += end;
    }
    if at.len() == first {
        return Cow::Borrowed(source);
    }
    let mut out = String::with_capacity(source.len() + (at.len() - first) * END.len_utf8());
    let mut copied = 0;
    for &end in &at[first..] {
        out.push_str(&source[copied..end]);
        out.push(END);
        copied = end;
    }
    out.push_str(&source[copied..]);
    Cow::Owned(out)
}

/// Whether `c` ends a bare URL.
fn stops_url(c: char) -> bool {
    is_cjk(c) || matches!(c, '‘' | '’' | '“' | '”')
}

/// The length of the prefix of a bare URL starting at byte `at` of
/// `source` (`http://`, `https://`, `www.`), as the parser starts one: a
/// protocol not after a letter, `www.` at the start of a word. `None` in
/// angle brackets and in a link's or definition's destination.
fn url_start(source: &str, at: usize) -> Option<usize> {
    let rest = &source.as_bytes()[at..];
    let before = source[..at].bytes().next_back();
    let prefix =
        |p: &str| rest.len() >= p.len() && rest[..p.len()].eq_ignore_ascii_case(p.as_bytes());
    let len = if prefix("https://") {
        8
    } else if prefix("http://") {
        7
    } else if prefix("www.") {
        if !matches!(
            before,
            None | Some(b'\t' | b'\n' | b' ' | b'(' | b'*' | b'_' | b'[' | b']' | b'~')
        ) {
            return None;
        }
        4
    } else {
        return None;
    };
    if before.is_some_and(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let written = source[..at].trim_end_matches([' ', '\t']);
    if before == Some(b'<') || written.ends_with("](") || written.ends_with("]:") {
        return None;
    }
    Some(len)
}

#[cfg(test)]
mod tests {
    use super::{END, end_urls};

    #[track_caller]
    fn check(input: &str, expected: &str) {
        let mut at = Vec::new();
        let ended = end_urls(input, &mut at);
        assert_eq!(
            ended,
            expected.replace('|', &END.to_string()),
            "input: {input:?}"
        );
        let mut expected_at = Vec::new();
        let mut offset = 0;
        for c in expected.chars() {
            if c == '|' {
                expected_at.push(offset);
            } else {
                offset += c.len_utf8();
            }
        }
        assert_eq!(at, expected_at, "input: {input:?}");
    }

    #[test]
    fn urls_end_at_cjk_text() {
        check(
            "https://example.com。下一句",
            "https://example.com|。下一句",
        );
        check(
            "见 https://a.dev/docs，然后",
            "见 https://a.dev/docs|，然后",
        );
        check("www.a.dev很好", "www.a.dev|很好");
        check("“https://a.dev”里", "“https://a.dev|”里");
        check("来源：https://x.dev**。", "来源：https://x.dev**|。");
        check(
            "https://a.dev中https://b.dev。",
            "https://a.dev|中https://b.dev|。",
        );
        check(
            "https://zh.wikipedia.org/wiki/中文",
            "https://zh.wikipedia.org/wiki/|中文",
        );
    }

    #[test]
    fn other_urls_are_left_alone() {
        check(
            "https://example.com/a?b#c. 中文",
            "https://example.com/a?b#c. 中文",
        );
        check("<https://a.dev/中文>", "<https://a.dev/中文>");
        check("[文档](https://a.dev/中文)", "[文档](https://a.dev/中文)");
        check("[a]: https://a.dev/中文", "[a]: https://a.dev/中文");
        check("xhttps://a.dev中", "xhttps://a.dev中");
        check("中www.a.dev很好", "中www.a.dev很好");
        check("café https://a.dev/é", "café https://a.dev/é");
    }
}
