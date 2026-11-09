//! TeX's own delimiters, which AI models often write formulas with:
//! `\(…\)` in text and `\[…\]` for display. Markdown reads `\(` as an
//! escaped parenthesis, so before parsing they are rewritten in the source
//! as the math syntax `markdown-rs` reads: `$$…$$` in text (a pair of
//! dollars, which the prose check of single dollars leaves alone) and a
//! `$$` fence for a display formula on lines of its own. Code (fences and
//! spans) is left as written. Escaped brackets that are no formula stay
//! text ([`is_formula`]): reference numbers (`\[1\]\[3\]`, `\[2, 5\]`)
//! and CJK words (`\[注\]`).

use super::mapped::{Source, Writer};
#[cfg(test)]
use std::borrow::Cow;

use super::{
    cjk::is_cjk,
    container::{fence_closes, fence_opens, strip_containers},
    streaming::{spans, tex_end},
};

/// `source` with its TeX delimiters rewritten as dollars.
#[cfg(test)]
pub(super) fn rewrite(source: &str) -> Cow<'_, str> {
    let rewritten = rewrite_mapped(Source::original(source));
    if &*rewritten == source {
        Cow::Borrowed(source)
    } else {
        Cow::Owned(rewritten.to_string())
    }
}

pub(super) fn rewrite_mapped(source: Source) -> Source {
    if !source.contains("\\(") && !source.contains("\\[") {
        return source;
    }
    let lines = lines(&source);
    let mut out = source.writer();
    // The lines of text (not code, not blank) not written out yet: a
    // formula in text may run over lines of a paragraph.
    let mut text: Option<usize> = None;
    let mut fence: Option<(u8, usize)> = None;
    let mut i = 0;
    while i < lines.len() {
        let (start, end, next) = lines[i];
        let line = &source[start..end];
        let content = strip_containers(line);
        if let Some((ch, len)) = fence {
            out.copy(&source[start..next]);
            if fence_closes(content, ch, len) {
                fence = None;
            }
            i += 1;
            continue;
        }
        let display = content.starts_with("\\[");
        if (fence_opens(content).is_some() || content.trim().is_empty() || display)
            && let Some(from) = text.take()
        {
            inline(&source[from..start], &mut out);
        }
        if let Some(open) = fence_opens(content) {
            fence = Some(open);
        } else if display && let Some(last) = display_end(&source, &lines, i) {
            display_formula(&source, &lines, i, last, &mut out);
            i = last + 1;
            continue;
        } else if !content.trim().is_empty() {
            text.get_or_insert(start);
            i += 1;
            continue;
        }
        out.copy(&source[start..next]);
        i += 1;
    }
    if let Some(from) = text {
        inline(&source[from..], &mut out);
    }
    out.finish()
}

/// The lines of `source`: start, end without the line ending, start of the
/// next.
fn lines(source: &str) -> Vec<(usize, usize, usize)> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < source.len() {
        let end = source[start..]
            .find('\n')
            .map_or(source.len(), |i| start + i);
        let next = (end + 1).min(source.len());
        lines.push((start, end, next));
        start = end + 1;
    }
    lines
}

/// The line that ends the display formula line `first` opens: the first
/// ending with `\]`, before a blank line.
fn display_end(source: &str, lines: &[(usize, usize, usize)], first: usize) -> Option<usize> {
    for (i, &(start, end, _)) in lines.iter().enumerate().skip(first) {
        let mut content = strip_containers(&source[start..end]).trim_end();
        if i == first {
            content = &content[2..];
            // `\[x\] and more`: a formula in text.
            if content.contains("\\]") && !content.ends_with("\\]") {
                return None;
            }
            // `\[1\]\[3\]`, `\[2\]`: text, read as such by `inline`.
            if let Some(body) = content.strip_suffix("\\]")
                && (body.contains("\\]") || !is_formula(body))
            {
                return None;
            }
        } else if content.is_empty() {
            return None;
        }
        if content.ends_with("\\]") && !content.ends_with("\\\\]") {
            return Some(i);
        }
    }
    None
}

/// The display formula of lines `first` to `last` as a `$$` fence.
fn display_formula(
    source: &str,
    lines: &[(usize, usize, usize)],
    first: usize,
    last: usize,
    out: &mut Writer<'_>,
) {
    let (start, end, _) = lines[first];
    let line = &source[start..end];
    let opener = line.find("\\[").unwrap_or(0);
    // The fences go where the formula's lines are: in the quote or list
    // item it is in (its marker as spaces, else it would start an item).
    let prefix: String = line[..opener]
        .chars()
        .map(|c| {
            if c == '>' || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    out.copy(&line[..opener]);
    out.replace_slice("$$", &line[opener..opener + 2]);
    out.push('\n');
    for (i, &(start, end, _)) in lines.iter().enumerate().take(last + 1).skip(first) {
        let mut body = if i == first {
            &source[start + opener + 2..end]
        } else {
            &source[start..end]
        };
        if i == last {
            body = body.trim_end();
            body = &body[..body.len() - 2];
        }
        let empty = if i == first {
            body.trim().is_empty()
        } else {
            strip_containers(body).trim().is_empty()
        };
        if !empty {
            if i == first {
                out.push_str(&prefix);
                out.copy(body.trim());
            } else {
                out.copy(body.trim_end());
            }
            out.push('\n');
        }
    }
    out.push_str(&prefix);
    let (close_start, close_end, _) = lines[last];
    let close = source[close_start..close_end].trim_end();
    out.replace_slice("$$", &close[close.len() - 2..]);
    if lines[last].1 < source.len() {
        out.push('\n');
    }
}

/// Text `text` (lines of a block) with its formulas `\(…\)` and `\[…\]`
/// as `$$…$$`, into `out`.
fn inline(text: &str, out: &mut Writer<'_>) {
    let (code, open_code) = spans(text, false);
    let bytes = text.as_bytes();
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if let Some(&(_, e)) = code.iter().find(|&&(s, _)| s == i) {
            i = e;
            continue;
        }
        if open_code.is_some_and(|(s, _)| i >= s) {
            break;
        }
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if let Some(end) = tex_end(text, i) {
            let body = &text[i + 2..end - 2];
            // Brackets in a row (`\[1\]\[3\]`) or holding no formula are
            // escaped brackets.
            let brackets = bytes[i + 1] == b'['
                && (text[end..].starts_with("\\[")
                    || text[..i].ends_with("\\]")
                    || !is_formula(body));
            // Dollars inside would end the formula early; a blank line
            // ends the paragraph.
            if !brackets && !body.trim().is_empty() && !body.contains('$') && !body.contains("\n\n")
            {
                out.copy(&text[copied..i]);
                out.replace_slice("$$", &text[i..i + 2]);
                out.copy(body);
                out.replace_slice("$$", &text[end - 2..end]);
                copied = end;
                i = end;
                continue;
            }
        }
        // An escape: the escaped character is not a delimiter.
        i += 2;
    }
    out.copy(&text[copied..]);
}

/// Whether `body`, between `\[` and `\]`, is a formula, not a reference
/// number (`1`, `2, 5`, `3-4`, `^1`) or CJK words with nothing of TeX's
/// (`注`, `来源`).
fn is_formula(body: &str) -> bool {
    let body = body.trim();
    let number = body.strip_prefix('^').unwrap_or(body);
    if !number.is_empty()
        && number.chars().all(|c| {
            c.is_ascii_digit()
                || c.is_whitespace()
                || matches!(c, ',' | '，' | '、' | '-' | '–' | '~')
        })
        && number.chars().any(|c| c.is_ascii_digit())
    {
        return false;
    }
    let tex = body.contains(['\\', '^', '_', '{', '}', '=']);
    tex || !body.chars().any(is_cjk)
}

#[cfg(test)]
mod tests {
    use super::rewrite;

    #[track_caller]
    fn check(input: &str, expected: &str) {
        assert_eq!(rewrite(input), expected, "input: {input:?}");
    }

    #[test]
    fn inline_formulas() {
        check("Euler \\(e^{i\\pi}\\) here", "Euler $$e^{i\\pi}$$ here");
        check("Inline \\[x^2\\] too", "Inline $$x^2$$ too");
        check("\\[x\\] starts a line", "$$x$$ starts a line");
        check("over\n\\(a +\nb\\) lines", "over\n$$a +\nb$$ lines");
        check("`\\(code\\)` and \\(x\\)", "`\\(code\\)` and $$x$$");
        check("escaped \\\\(x\\\\)", "escaped \\\\(x\\\\)");
        check("costs \\($5\\)", "costs \\($5\\)");
        check("plain (x) and [y]", "plain (x) and [y]");
    }

    #[test]
    fn display_formulas() {
        check(
            "Text\n\n\\[\nx = 1\n\\]\n\nAfter",
            "Text\n\n$$\nx = 1\n$$\n\nAfter",
        );
        check("\\[ x = 1 \\]", "$$\nx = 1\n$$");
        check("\\[ a\nb \\]\nnext", "$$\na\nb\n$$\nnext");
        check("> \\[\n> x\n> \\]", "> $$\n> x\n> $$");
        check("- \\[\n  x\n  \\]", "- $$\n  x\n  $$");
        check("```\n\\[\nx\n\\]\n```", "```\n\\[\nx\n\\]\n```");
        // Not closed: text.
        check("\\[\nx\n\nmore", "\\[\nx\n\nmore");
    }

    #[test]
    fn escaped_brackets_that_are_no_formula() {
        // Reference numbers, in a row or alone, on a line of their own or in
        // text.
        check("\\[1\\]\\[3\\]", "\\[1\\]\\[3\\]");
        check("见文献\\[1\\]\\[3\\]。", "见文献\\[1\\]\\[3\\]。");
        check(
            "as shown \\[2, 5\\] and \\[^1\\]",
            "as shown \\[2, 5\\] and \\[^1\\]",
        );
        check("\\[12\\]", "\\[12\\]");
        check("\\[a\\]\\[b\\]", "\\[a\\]\\[b\\]");
        check("\\[x_1\\]\\[3\\]", "\\[x_1\\]\\[3\\]");
        // CJK words with nothing of TeX's.
        check("\\[注\\] 正文", "\\[注\\] 正文");
        // Formulas still: TeX in them, Latin variables, CJK in `\text`.
        check("\\[ x + 1 \\]", "$$\nx + 1\n$$");
        check(
            "面积 \\[\\text{面积} = a^2\\] 如上",
            "面积 $$\\text{面积} = a^2$$ 如上",
        );
        check("\\[2^{10}\\]", "$$\n2^{10}\n$$");
        // `\(…\)` is unchanged: a number is a formula there.
        check("答案是 \\(2\\)", "答案是 $$2$$");
    }
}
