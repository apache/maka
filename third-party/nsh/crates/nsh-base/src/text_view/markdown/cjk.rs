//! Emphasis beside Chinese, Japanese and Korean text, read as the
//! CJK-friendly amendment to CommonMark reads it
//! (<https://github.com/tats-u/markdown-cjk-friendly>, proposed in
//! commonmark-spec#650; markdown-it's and remark's `cjk-friendly` plugins).
//!
//! CommonMark decides whether `**` opens or closes by the characters around
//! it, and counts full-width punctuation as punctuation: in `**涨幅：**5%`
//! the closing `**` follows punctuation and precedes a digit, so it closes
//! nothing and the stars show. The amendment reads CJK punctuation as
//! letters and a CJK character beside punctuation as a word boundary.
//! `markdown-rs` keeps CommonMark's reading, so a delimiter run of `*` or
//! `~` that the amendment lets open or close where CommonMark does not gets
//! [`MARK`] between it and the punctuation beside it before parsing; the
//! parser takes the mark for a letter, and `offsets.rs` takes it out of the
//! tree after parsing. `_` reads the same under both rules, and text
//! without CJK characters is never changed.

use std::{borrow::Cow, sync::OnceLock};

use regex::Regex;

/// What is placed beside a delimiter run: a noncharacter (Unicode keeps
/// them for a program's internal use), which `markdown-rs` classes with
/// letters. One in the source is removed with the ones placed.
pub(super) const MARK: char = '\u{FDD0}';

/// `source` with [`MARK`] beside the delimiter runs the CJK-friendly rule
/// lets open or close where CommonMark does not; where each went (offsets
/// in `source`, in order) is pushed to `at`.
pub(super) fn mark<'s>(source: &'s str, marks: &mut Vec<usize>) -> Cow<'s, str> {
    if source.is_ascii() || !source.contains(['*', '~']) {
        return Cow::Borrowed(source);
    }
    let bytes = source.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let marker = bytes[i];
        if marker != b'*' && marker != b'~' {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i] == marker {
            i += 1;
        }
        // An escaped first marker is text: the run starts after it, beside
        // a marker, which the parser lets open and close already.
        if escaped(bytes, start) {
            continue;
        }
        let before = source[..start].chars().next_back();
        let after = source[i..].chars().next();
        let at = match flank(&source[..start], before, after) {
            Some(Side::Before) => start,
            Some(Side::After) => i,
            None => continue,
        };
        let out = out.get_or_insert_with(|| String::with_capacity(source.len() + 8));
        out.push_str(&source[copied..at]);
        out.push(MARK);
        marks.push(at);
        copied = at;
    }
    match out {
        Some(mut out) => {
            out.push_str(&source[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(source),
    }
}

/// Where a mark goes beside a run.
#[derive(Debug, PartialEq, Eq)]
enum Side {
    Before,
    After,
}

/// What `markdown-rs` classes a character beside a delimiter run as.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Whitespace,
    Punctuation,
    Other,
}

fn class(c: Option<char>) -> Class {
    match c {
        None => Class::Whitespace,
        Some(c) if c.is_whitespace() => Class::Whitespace,
        Some(c) if is_punctuation(c) => Class::Punctuation,
        Some(_) => Class::Other,
    }
}

/// Which side of a run (`before` it, `after` it; `line` is the source up to
/// it) takes a mark: the side of the punctuation, when the CJK-friendly rule
/// lets the run open or close and CommonMark does not. Then the rule lets it
/// do both, which a letter on each side gives.
fn flank(line: &str, before: Option<char>, after: Option<char>) -> Option<Side> {
    // Beside another marker the parser already lets a run open and close,
    // and a mark there would change how that marker reads.
    let delimiter = |c: Option<char>| matches!(c, Some('*' | '_' | '~'));
    if delimiter(before) || delimiter(after) {
        return None;
    }
    match (class(before), class(after)) {
        // Cannot open: punctuation after it, a letter before. The rule lets
        // it when the punctuation is CJK or the letter is.
        (Class::Other, Class::Punctuation)
            if after.is_some_and(is_cjk) || before.is_some_and(|c| cjk_before(line, c)) =>
        {
            Some(Side::After)
        }
        // Cannot close: punctuation before it, a letter after. The rule
        // lets it when the punctuation is CJK or the letter is; not at the
        // start of a quote's line, where the `>` is no text.
        (Class::Punctuation, Class::Other)
            if (before.is_some_and(is_cjk) || after.is_some_and(is_cjk)) && !starts_line(line) =>
        {
            Some(Side::Before)
        }
        _ => None,
    }
}

/// Whether the character `c` ending `line` counts as CJK before a run: a CJK
/// character, an ideographic variation selector, or a variation selector
/// after a CJK character.
fn cjk_before(line: &str, c: char) -> bool {
    match c {
        '\u{E0100}'..='\u{E01EF}' => true,
        '\u{FE00}'..='\u{FE0E}' => {
            let mut chars = line.chars();
            chars.next_back();
            chars.next_back().is_some_and(is_cjk)
        }
        c => is_cjk(c),
    }
}

/// Whether `line` (the source up to a run) is only the start of a line and
/// quote markers.
fn starts_line(line: &str) -> bool {
    let start = line.rfind('\n').map_or(0, |i| i + 1);
    line[start..]
        .bytes()
        .all(|b| matches!(b, b' ' | b'\t' | b'>'))
}

/// Whether the byte at `at` is escaped by a backslash.
fn escaped(bytes: &[u8], at: usize) -> bool {
    bytes[..at]
        .iter()
        .rev()
        .take_while(|&&b| b == b'\\')
        .count()
        % 2
        == 1
}

/// Unicode punctuation as CommonMark counts it: the general categories P
/// (punctuation) and S (symbols).
fn is_punctuation(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_punctuation();
    }
    static PUNCTUATION: OnceLock<Regex> = OnceLock::new();
    let regex = PUNCTUATION.get_or_init(|| Regex::new(r"[\p{P}\p{S}]").expect("valid pattern"));
    regex.is_match(c.encode_utf8(&mut [0; 4]))
}

/// Whether `c` is a CJK character as the amendment defines it: East Asian
/// Width wide, full-width or half-width and no emoji, or Hangul (its ranges,
/// Unicode 18).
pub(super) fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x1100..=0x11ff
            | 0x20a9
            | 0x2329..=0x232a
            | 0x2630..=0x2637
            | 0x268a..=0x268f
            | 0x2e80..=0x2e99
            | 0x2e9b..=0x2ef3
            | 0x2f00..=0x2fd5
            | 0x2ff0..=0x303e
            | 0x3041..=0x3096
            | 0x3099..=0x30ff
            | 0x3105..=0x312f
            | 0x3131..=0x318e
            | 0x3190..=0x31e5
            | 0x31ef..=0x321e
            | 0x3220..=0x3247
            | 0x3250..=0xa48c
            | 0xa490..=0xa4c6
            | 0xa960..=0xa97c
            | 0xac00..=0xd7a3
            | 0xd7b0..=0xd7c6
            | 0xd7cb..=0xd7fb
            | 0xf900..=0xfaff
            | 0xfe10..=0xfe19
            | 0xfe30..=0xfe52
            | 0xfe54..=0xfe66
            | 0xfe68..=0xfe6b
            | 0xff01..=0xffbe
            | 0xffc2..=0xffc7
            | 0xffca..=0xffcf
            | 0xffd2..=0xffd7
            | 0xffda..=0xffdc
            | 0xffe0..=0xffe6
            | 0xffe8..=0xffee
            | 0x16fe0..=0x16fe4
            | 0x16ff0..=0x16ff6
            | 0x17000..=0x18cda
            | 0x18cff..=0x18d20
            | 0x18d80..=0x18df2
            | 0x18e00..=0x19191
            | 0x191a0..=0x191d2
            | 0x1aff0..=0x1aff3
            | 0x1aff5..=0x1affb
            | 0x1affd..=0x1affe
            | 0x1b000..=0x1b128
            | 0x1b132
            | 0x1b150..=0x1b152
            | 0x1b155
            | 0x1b164..=0x1b168
            | 0x1b170..=0x1b2fb
            | 0x1d300..=0x1d356
            | 0x1d360..=0x1d376
            | 0x1f1ae
            | 0x1f200
            | 0x1f202
            | 0x1f210..=0x1f219
            | 0x1f21b..=0x1f22e
            | 0x1f230..=0x1f231
            | 0x1f237
            | 0x1f23b
            | 0x1f240..=0x1f248
            | 0x1f260..=0x1f265
            | 0x1f7da
            | 0x20000..=0x3fffd
    )
}

#[cfg(test)]
mod tests {
    use super::{MARK, mark};

    #[track_caller]
    fn check(input: &str, expected: &str) {
        let mut marks = Vec::new();
        let marked = mark(input, &mut marks);
        assert_eq!(
            marked,
            expected.replace('|', &MARK.to_string()),
            "input: {input:?}"
        );
        // Where each mark went, in the input.
        let mut at = Vec::new();
        let mut offset = 0;
        for c in expected.chars() {
            if c == '|' {
                at.push(offset);
            } else {
                offset += c.len_utf8();
            }
        }
        assert_eq!(marks, at, "input: {input:?}");
    }

    #[test]
    fn marks_beside_cjk_punctuation() {
        // Closing after full-width punctuation, before a digit or letter.
        check("**涨幅：**5%", "**涨幅：|**5%");
        check("**注意：**这里", "**注意：|**这里");
        // Opening after a CJK letter, before punctuation (CJK or not).
        check("中**“引号”**中", "中**|“引号”|**中");
        check("这是**「重点」**吗", "这是**|「重点」|**吗");
        check("~~删除：~~了", "~~删除：|~~了");
    }

    #[test]
    fn leaves_other_text_alone() {
        check("**bold** and *it*", "**bold** and *it*");
        check("a**\"b\"**c", "a**\"b\"**c");
        check("中**文**字", "中**文**字");
        // Not CJK: Latin letters beside non-CJK punctuation.
        check("naïve**“q”**x", "naïve**“q”**x");
        // In code too (removed again from the tree).
        check("`**涨幅：**5%`", "`|**涨幅：|**5%`");
        check("\\**涨幅：\\**5%", "\\**涨幅：\\**5%");
        check("> **中文**", "> **中文**");
        check(">**中文**", ">**中文**");
        check("**中**_", "**中**_");
        check("- 列表 * 项", "- 列表 * 项");
    }
}
