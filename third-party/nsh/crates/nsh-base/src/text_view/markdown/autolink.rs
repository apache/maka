//! Bare URLs (GitHub's autolink literals: `https://…`, `www.…`) ending
//! where Chinese, Japanese or Korean text starts. A literal runs to the next
//! whitespace, and CJK text puts no space after a URL: `https://example.com。
//! 下一句` would link `。下一句` too. A URL ends before the first CJK
//! punctuation mark (full-width forms included) or curly quotation mark
//! (`‘’“”`, which CJK text quotes with), and before any other CJK character
//! (`cjk::is_cjk`) only until its path starts: `https://example.com中文`
//! ends at `中`, `https://zh.wikipedia.org/wiki/中文` keeps it. [`END`], a
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
        // Letters of any script belong to a path (`/wiki/中文`); before
        // the path starts, a CJK letter is prose after the host.
        let rest = &source[i..];
        let mut in_path = false;
        let mut end = rest.len();
        let mut stopped = false;
        for (j, c) in rest.char_indices() {
            if c.is_whitespace() || c == '<' {
                end = j;
                break;
            }
            if stops_url(c, in_path) {
                end = j;
                stopped = true;
                break;
            }
            in_path |= c == '/';
        }
        if stopped {
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

/// Whether `c` ends a bare URL: CJK punctuation (full-width forms
/// included) and curly quotes anywhere, other CJK characters only before
/// the path starts (`in_path`, a `/` after the host).
fn stops_url(c: char, in_path: bool) -> bool {
    is_cjk_punctuation(c) || (!in_path && is_cjk(c))
}

/// CJK and full-width punctuation and curly quotation marks: symbols and
/// punctuation (`、。「」…`), vertical and small forms, and the full-width
/// ASCII punctuation (`！，：（）［］｛｝`) and half-width CJK punctuation.
fn is_cjk_punctuation(c: char) -> bool {
    matches!(
        c,
        '‘' | '’'
            | '“'
            | '”'
            | '\u{3000}'..='\u{303F}'
            | '\u{FE10}'..='\u{FE1F}'
            | '\u{FE30}'..='\u{FE6F}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
    )
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
        check("https://example.com中文", "https://example.com|中文");
        check("https://a.dev/文档）后", "https://a.dev/文档|）后");
        check("https://a.dev/文档、后", "https://a.dev/文档|、后");
        check("https://a.dev/文档！", "https://a.dev/文档|！");
    }

    #[test]
    fn cjk_paths_stay_in_urls() {
        check(
            "https://zh.wikipedia.org/wiki/中文",
            "https://zh.wikipedia.org/wiki/中文",
        );
        check(
            "https://zh.wikipedia.org/wiki/2024年",
            "https://zh.wikipedia.org/wiki/2024年",
        );
        check(
            "https://zh.wikipedia.org/wiki/C語言",
            "https://zh.wikipedia.org/wiki/C語言",
        );
        check(
            "- 链接：https://example.com/p/日志脱敏-gear-log-与-zaplog",
            "- 链接：https://example.com/p/日志脱敏-gear-log-与-zaplog",
        );
        check(
            "https://ko.wikipedia.org/wiki/한국어",
            "https://ko.wikipedia.org/wiki/한국어",
        );
        check(
            "https://zh.wikipedia.org/wiki/中文，然后",
            "https://zh.wikipedia.org/wiki/中文|，然后",
        );
        check(
            "https://zh.wikipedia.org/wiki/中文。下一句",
            "https://zh.wikipedia.org/wiki/中文|。下一句",
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
