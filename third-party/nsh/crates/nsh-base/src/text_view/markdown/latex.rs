//! TeX's own delimiters, which AI models often write formulas with:
//! `\(…\)` in text and `\[…\]` for display. Markdown reads `\(` as an
//! escaped parenthesis, so before parsing they are rewritten in the source
//! as the math syntax `markdown-rs` reads: `$$…$$` in text (a pair of
//! dollars, which the prose check of single dollars leaves alone) and a
//! `$$` fence for a display formula on lines of its own. Code (fences and
//! spans) is left as written.

use super::mapped::{Source, Writer};
#[cfg(test)]
use std::borrow::Cow;

use super::{
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
            // Dollars inside would end the formula early; a blank line
            // ends the paragraph.
            if !body.trim().is_empty() && !body.contains('$') && !body.contains("\n\n") {
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
}
