//! The end of Markdown still arriving (an AI model's reply, token by
//! token), repaired so syntax it leaves open shows as it will once closed:
//! `**bold` as bold, `` `code `` as code, `[text](htt` as its text, a
//! table's header as a table, instead of the markers as text until the
//! rest arrives. Only the last block is touched: the blocks before it are
//! complete. A last line whose meaning the next characters decide (a list
//! marker alone, a `-` or `=` line that may underline a heading, a fence
//! being opened or closed) is held back until its line ends; a finished
//! document is parsed as written.

#[cfg(test)]
use std::borrow::Cow;

use super::{
    cjk::is_cjk,
    container::{fence_closes, fence_opens, strip_containers},
    mapped::Source,
};

/// `source` with the syntax its last block leaves open closed.
#[cfg(test)]
pub(crate) fn repair_streaming(source: &str) -> Cow<'_, str> {
    let repaired = repair_mapped(Source::original(source));
    if &*repaired == source {
        Cow::Borrowed(source)
    } else {
        Cow::Owned(repaired.to_string())
    }
}

pub(super) fn repair_mapped(source: Source) -> Source {
    let tail_start = match last_block(&source) {
        Last::Block(start) => start,
        Last::Fenced => return source,
        Last::Hold(at) => {
            let keep = source[..at].trim_end().len();
            return repair_mapped(source.slice(0..keep));
        }
    };
    let tail = source.slice(tail_start..source.len());
    if tail.trim().is_empty() {
        return source;
    }
    let repaired = table(&tail).unwrap_or_else(|| {
        let mut text = match held_line(&tail) {
            Some(at) => inline(&tail.slice(0..tail[..at].trim_end().len())),
            None => inline(&tail),
        };
        // Repair may leave a marker alone (`- **` without its `**`).
        while let Some(at) = held_line(&text) {
            text = inline(&text.slice(0..text[..at].trim_end().len()));
        }
        text
    });
    let mut out = source.slice(0..tail_start);
    out.append(&repaired);
    out
}

/// Where the last block of a streamed source starts.
enum Last {
    /// After its last blank line or fenced block, at this offset.
    Block(usize),
    /// Inside a fenced block of code or math, which runs to the end and
    /// needs no repair.
    Fenced,
    /// A fence's opening line or the start of its closer still being typed
    /// on the last line, held back from this offset.
    Hold(usize),
}

/// Where the last block of `source` starts (after its last blank line or
/// fenced block).
fn last_block(source: &str) -> Last {
    let mut code: Option<(u8, usize)> = None;
    let mut math = false;
    let mut start = 0;
    let mut tail = 0;
    while start < source.len() {
        let end = source[start..]
            .find('\n')
            .map_or(source.len(), |i| start + i);
        // The last line, its end not arrived: what follows may change it.
        let open_end = end == source.len();
        let next = end + 1;
        let line = strip_containers(&source[start..end]);
        if let Some((ch, len)) = code {
            if fence_closes(line, ch, len) {
                code = None;
                tail = next;
            } else if open_end && closer_typed(line, ch, len) {
                // `` `` `` of a closing ```` ``` ````: not code.
                return Last::Hold(start);
            }
        } else if math {
            if line.trim_start().starts_with("$$") {
                math = false;
                tail = next;
            }
        } else if let Some(open) = fence_opens(line) {
            if open_end {
                // The info string is still arriving (```` ```pyth ````):
                // no empty block of code before its first line.
                return Last::Hold(start);
            }
            code = Some(open);
        } else if line
            .trim_start()
            .strip_prefix("$$")
            .is_some_and(|rest| !rest.contains('$'))
        {
            math = true;
        } else if line.trim().is_empty() && !open_end {
            // Markers alone on the last line (`- `) are no blank line yet.
            tail = next;
        }
        start = next;
    }
    if code.is_some() || math {
        Last::Fenced
    } else {
        Last::Block(tail.min(source.len()))
    }
}

/// Whether `line` is the start of a closing fence of `len` characters
/// `ch`, fewer of them so far.
fn closer_typed(line: &str, ch: u8, len: usize) -> bool {
    let rest = line.trim_end();
    !rest.is_empty() && rest.len() < len && rest.bytes().all(|b| b == ch)
}

/// Where the last line of `tail` starts when its end has not arrived and
/// what it holds so far means nothing yet, or something else once more
/// arrives: a list marker alone (`-`, `2.`, an empty item now; an item or
/// text later), digits that may become one, or a line of `-` or `=` (a
/// heading's underline now; a rule, an item or text later).
fn held_line(tail: &str) -> Option<usize> {
    if tail.ends_with('\n') {
        return None;
    }
    let start = tail.rfind('\n').map_or(0, |i| i + 1);
    let line = &tail[start..];
    let content = strip_containers(line);
    let trimmed = content.trim_end();
    // Digits start an item only where the line's content starts (`2.`),
    // not as an item's content (`+ 2`).
    let unquoted = line.trim_start_matches(['>', ' ', '\t']).trim_end();
    let digits = unquoted.strip_suffix(['.', ')']).unwrap_or(unquoted);
    let marker = trimmed.is_empty()
        || matches!(trimmed, "-" | "*" | "+")
        || (!digits.is_empty() && digits.len() < 10 && digits.bytes().all(|b| b.is_ascii_digit()));
    let underline = trimmed.bytes().all(|b| matches!(b, b'-' | b' ' | b'\t'))
        || trimmed.bytes().all(|b| b == b'=');
    // Whitespace alone is a blank line once it ends: nothing to hold.
    (!line.trim().is_empty() && (marker || underline)).then_some(start)
}

/// A table's header followed by its delimiter row being typed (`| a | b |`
/// then `| --`): the delimiter row completed to the header's width, so the
/// header shows as a table (and not, for a lone `-`, as a heading).
fn table(tail: &Source) -> Option<Source> {
    let body = tail.trim_end_matches('\n');
    let (header, delimiter) = body.split_once('\n')?;
    if delimiter.contains('\n') || !header.contains('|') {
        return None;
    }
    let delimiter = delimiter.trim();
    if delimiter.is_empty()
        || !delimiter
            .bytes()
            .all(|b| matches!(b, b'|' | b'-' | b':' | b' ' | b'\t'))
    {
        return None;
    }
    if !delimiter.contains('-') {
        // Nothing a column could be made of yet: the header alone.
        return Some(tail.slice(0..header.len()));
    }
    let columns = cells(header).len().max(1);
    let typed = cells(delimiter);
    let mut row = String::from("|");
    for i in 0..columns {
        let cell = typed.get(i).map_or("", |c| c.trim());
        let left = cell.starts_with(':');
        let right = cell.len() > 1 && cell.ends_with(':');
        row.push(' ');
        row.push_str(if left { ":---" } else { "---" });
        if right {
            row.push(':');
        }
        row.push_str(" |");
    }
    let mut out = tail.slice(0..header.len());
    out.push("\n");
    out.push(&row);
    Some(out)
}

/// The cells of a table row (unescaped `|` separate them; the outer ones
/// are optional).
fn cells(row: &str) -> Vec<&str> {
    let row = row.trim();
    let mut out = Vec::new();
    let mut start = 0;
    let mut escaped = false;
    for (i, b) in row.bytes().enumerate() {
        match b {
            b'\\' if !escaped => {
                escaped = true;
                continue;
            }
            b'|' if !escaped => {
                out.push(&row[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        escaped = false;
    }
    out.push(&row[start..]);
    if row.starts_with('|') {
        out.remove(0);
    }
    if row.ends_with('|') && row.len() > 1 && !out.is_empty() {
        out.pop();
    }
    out
}

/// The inline syntax the last block leaves open, closed.
fn inline(tail: &Source) -> Source {
    let text = tex(tail);
    let text = links(&text);
    let text = tag(&text);
    let mut text = close(&text);
    if *text != **tail {
        text.truncate(text.trim_end().len());
    }
    text
}

/// A range of bytes, `(start, end)` or `(start, len)`.
pub(super) type Span = (usize, usize);

/// The spans of inline code and TeX formulas (`\\(…\\)`, `\\[…\\]`) of
/// `text`, whose content is left alone.
fn code_spans(text: &str) -> (Vec<Span>, Option<Span>) {
    spans(text, true)
}

/// The spans of inline code of `text` (from their first backtick to after
/// their last), with `tex` those of TeX formulas too, and the start and
/// length of an opening backtick run nothing closes.
pub(super) fn spans(text: &str, tex: bool) -> (Vec<Span>, Option<Span>) {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            if tex && let Some(end) = tex_end(text, i) {
                spans.push((i, end));
                i = end;
                continue;
            }
            i += 2;
            continue;
        }
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let len = run(bytes, i, b'`');
        let mut j = i + len;
        let mut closed = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let n = run(bytes, j, b'`');
                if n == len {
                    closed = Some(j + n);
                    break;
                }
                j += n;
            } else {
                j += 1;
            }
        }
        match closed {
            Some(end) => {
                spans.push((i, end));
                i = end;
            }
            None => return (spans, Some((i, len))),
        }
    }
    (spans, None)
}

/// The end (after its closer) of the TeX formula `\\(` or `\\[` opens at
/// `at`, if closed.
pub(super) fn tex_end(text: &str, at: usize) -> Option<usize> {
    let closer = match text.as_bytes().get(at + 1)? {
        b'(' => "\\)",
        b'[' => "\\]",
        _ => return None,
    };
    text[at + 2..].find(closer).map(|i| at + 2 + i + 2)
}

fn run(bytes: &[u8], at: usize, b: u8) -> usize {
    bytes[at..].iter().take_while(|&&c| c == b).count()
}

/// Whether byte `i` is outside code.
fn outside(spans: &[Span], open: Option<Span>, i: usize) -> bool {
    !spans.iter().any(|&(s, e)| (s..e).contains(&i)) && open.is_none_or(|(s, _)| i < s)
}

/// A TeX formula left open (`\\(x`, `\\[` and lines of it) closed, or
/// removed while nothing follows its opener.
fn tex(text: &Source) -> Source {
    let (code, open_code) = spans(text, false);
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !outside(&code, open_code, i) {
            i += 1;
            continue;
        }
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if !matches!(bytes.get(i + 1), Some(b'(' | b'[')) {
            i += 2;
            continue;
        }
        match tex_end(text, i) {
            Some(end) => i = end,
            None => {
                let mut body = text[i + 2..].trim_end();
                // An odd backslash at the end is the closer arriving
                // (`\[1\`): without it the body reads as it will once
                // closed, so `\[1\]` never shows a formula of `1\`. An
                // even run is TeX's line break (`\\`).
                let backslashes = body.bytes().rev().take_while(|&b| b == b'\\').count();
                if backslashes % 2 == 1 {
                    body = &body[..body.len() - 1];
                }
                if body.trim().is_empty() {
                    return text.slice(0..text[..i].trim_end().len());
                }
                let mut out = text.slice(0..text[..i + 2 + body.len()].trim_end().len());
                if bytes[i + 1] == b'(' {
                    out.push("\\)");
                } else if body.contains('\n') {
                    // A display formula of lines of its own: its closer on
                    // a line of its own.
                    out.push("\n\\]");
                } else {
                    out.push("\\]");
                }
                return out;
            }
        }
    }
    text.clone()
}

/// Links and images not finished: `[text` and `[text](partial` as their
/// text, `![alt` and `![alt](partial` removed.
fn links(text: &Source) -> Source {
    let (spans, open) = code_spans(text);
    let bytes = text.as_bytes();
    // Ranges removed, and for a link whose destination is unfinished the
    // ranges of its syntax.
    let mut remove: Vec<(usize, usize)> = Vec::new();
    let mut brackets: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !outside(&spans, open, i) {
            i += 1;
            continue;
        }
        match bytes[i] {
            b'\\' => {
                i += 2;
                continue;
            }
            b'[' => brackets.push(i),
            b']' => {
                if let Some(start) = brackets.pop()
                    && bytes.get(i + 1) == Some(&b'(')
                    && destination_end(bytes, i + 2).is_none()
                {
                    // The destination runs to the end: drop it.
                    let image = start > 0 && bytes[start - 1] == b'!';
                    if image {
                        remove.push((start - 1, bytes.len()));
                    } else {
                        remove.push((start, start + 1));
                        remove.push((i, bytes.len()));
                    }
                    brackets.clear();
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    for start in brackets {
        let image = start > 0 && bytes[start - 1] == b'!';
        if image || bytes.get(start + 1) == Some(&b'^') {
            // An image's alt or a footnote's label being typed shows
            // nothing.
            remove.push((start - usize::from(image), bytes.len()));
        } else {
            remove.push((start, start + 1));
        }
    }
    if remove.is_empty() {
        return text.clone();
    }
    remove.sort_unstable();
    let mut out = text.writer();
    let mut at = 0;
    for (s, e) in remove {
        if s > at {
            out.copy(&text[at..s]);
        }
        at = at.max(e);
    }
    if at < text.len() {
        out.copy(&text[at..]);
    }
    out.finish()
}

/// Where a link destination starting at `from` ends (after its `)`).
fn destination_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1,
            b'(' => depth += 1,
            b')' if depth == 0 => return Some(i + 1),
            b')' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// An HTML tag (or autolink) being typed at the end, removed: `<`, `<di`,
/// `<a href="x`, `</`.
fn tag(text: &Source) -> Source {
    let (spans, open) = code_spans(text);
    let Some(lt) = text.rfind('<') else {
        return text.clone();
    };
    if !outside(&spans, open, lt)
        || text[lt..].contains('>')
        || (lt > 0 && text.as_bytes()[lt - 1] == b'\\')
    {
        return text.clone();
    }
    let after = &text[lt + 1..];
    let tagged = after
        .chars()
        .next()
        .is_none_or(|c| c.is_ascii_alphabetic() || c == '/' || c == '!');
    if tagged && !after.contains('\n') {
        text.slice(0..text[..lt].trim_end_matches([' ', '\t']).len())
    } else {
        text.clone()
    }
}

/// Inline code and emphasis (`**`, `*`, `__`, `_`, `~~`) and formulas
/// (`$$`, `$`) left open, closed in the reverse order they opened; a marker
/// with nothing after it yet is removed instead.
fn close(text: &Source) -> Source {
    let (spans, open_code) = code_spans(text);
    // A run of markers at the end after a space opens nothing yet (`a **`):
    // removed.
    let trimmed = text.trim_end();
    let run_start = trimmed.trim_end_matches(['*', '_', '~']).len();
    if run_start < trimmed.len()
        && trimmed[..run_start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace)
        && open_code.is_none_or(|(s, _)| s > run_start)
    {
        return close(&text.slice(0..trimmed[..run_start].trim_end().len()));
    }
    let bytes = text.as_bytes();
    let scan_end = open_code.map_or(bytes.len(), |(s, _)| s);
    let mut stack: Vec<(&'static str, usize)> = Vec::new();
    let mut i = 0;
    while i < scan_end {
        if let Some(&(_, e)) = spans.iter().find(|&&(s, _)| s == i) {
            i = e;
            continue;
        }
        let b = bytes[i];
        if b == b'\\' {
            i += 2;
            continue;
        }
        if !matches!(b, b'*' | b'_' | b'~' | b'$') {
            i += 1;
            continue;
        }
        let len = run(bytes, i, b).min(scan_end - i);
        let prev = text[..i].chars().next_back();
        let next = text[i + len..].chars().next();
        // A lone `*` inside a word (`a*b`, `2*3`) is as often text as
        // emphasis: left for the rest to decide, never closed.
        let in_word =
            b == b'*' && len == 1 && prev.is_some_and(word_char) && next.is_some_and(word_char);
        let can_open = next.is_some_and(|c| !c.is_whitespace())
            && !in_word
            && (b != b'_' || !prev.is_some_and(char::is_alphanumeric))
            && (b != b'$' || !next.is_some_and(|c| c.is_ascii_digit()));
        let can_close = prev.is_some_and(|c| !c.is_whitespace())
            && (b != b'_' || !next.is_some_and(char::is_alphanumeric));
        let tokens: &[&'static str] = match (b, len) {
            (b'*', 1) => &["*"],
            (b'*', 2) => &["**"],
            (b'*', 3) => &["*", "**"],
            (b'_', 1) => &["_"],
            (b'_', 2) => &["__"],
            (b'_', 3) => &["_", "__"],
            (b'~', 2) => &["~~"],
            (b'$', 1) => &["$"],
            (b'$', 2) => &["$$"],
            _ => &[],
        };
        let mut opened: Vec<&'static str> = Vec::new();
        for &token in tokens {
            let open = stack.iter().rposition(|&(t, _)| t == token);
            match open {
                Some(at) if can_close => {
                    stack.remove(at);
                }
                _ if can_open => opened.push(token),
                _ => {}
            }
        }
        // Opening `***`: the strong outside, the emphasis inside.
        for token in opened.into_iter().rev() {
            stack.push((token, i));
        }
        i += len;
    }

    let mut out = text.clone();
    // A code span with nothing in it yet: its backticks removed.
    let mut code_closer = None;
    if let Some((s, len)) = open_code {
        if text[s + len..].trim().is_empty() {
            out.truncate(s);
        } else {
            code_closer = Some(len);
        }
    }
    // Markers with nothing after them yet: removed.
    while code_closer.is_none()
        && let Some(&(_, at)) = stack.last()
        && out[at..]
            .trim_start_matches(['*', '_', '~', '$'])
            .trim()
            .is_empty()
    {
        out.truncate(at);
        stack.pop();
    }
    if code_closer.is_none() && stack.is_empty() {
        if out.len() != text.len() {
            out.truncate(out.trim_end().len());
        }
        return out;
    }
    let keep = out.trim_end().len();
    out.truncate(keep);
    if let Some(len) = code_closer {
        out.push(&"`".repeat(len));
    }
    for (token, _) in stack.iter().rev() {
        out.push(token);
    }
    out
}

/// A letter or digit of a word with spaces between words (CJK text has
/// none, so its emphasis is the CJK-friendly rule's).
fn word_char(c: char) -> bool {
    c.is_alphanumeric() && !is_cjk(c)
}

#[cfg(test)]
mod tests {
    use super::repair_streaming as repair;

    #[track_caller]
    fn check(input: &str, expected: &str) {
        assert_eq!(repair(input), expected, "input: {input:?}");
    }

    #[test]
    fn emphasis() {
        check("Some **bold", "Some **bold**");
        check("Some *it", "Some *it*");
        check("Some __bold", "Some __bold__");
        check("Some _it", "Some _it_");
        check("Some ~~gone", "Some ~~gone~~");
        check("**bold *both", "**bold *both***");
        check("***both", "***both***");
        check("**done** and *open", "**done** and *open*");
        check("**done**", "**done**");
        check("snake_case_name", "snake_case_name");
        check("2 * 3 * 4", "2 * 3 * 4");
        check("- item\n- **bo", "- item\n- **bo**");
        check("**bold ", "**bold**");
        check("Text **", "Text");
        check("Text **bold** *", "Text **bold**");
        check("escaped \\*star", "escaped \\*star");
    }

    #[test]
    fn code() {
        check("Use `cod", "Use `cod`");
        check("Use `", "Use");
        check("Use `a*b` and **x", "Use `a*b` and **x**");
        check("**bold `code", "**bold `code`**");
        check("``a ` b", "``a ` b``");
        // In a fence nothing changes: it runs to the end.
        check("```rust\nlet a = **b", "```rust\nlet a = **b");
        check("> ```\n> **x", "> ```\n> **x");
        // Earlier blocks are complete.
        check("**a\n\nb", "**a\n\nb");
        check("```\n**x\n```\n**y", "```\n**x\n```\n**y**");
    }

    #[test]
    fn math() {
        check("Formula $$x^2", "Formula $$x^2$$");
        check("Inline $x^2", "Inline $x^2$");
        check("Costs $5 and more", "Costs $5 and more");
        check("$$\nx^2", "$$\nx^2");
    }

    #[test]
    fn tex() {
        check("Euler \\(e^{i", "Euler \\(e^{i\\)");
        check("Display \\[x^2", "Display \\[x^2\\]");
        check("\\[\nx = 1\n+ 2", "\\[\nx = 1\n+ 2\n\\]");
        check("Opened \\(", "Opened");
        // The closer half arrived: its backslash is not the body's.
        check("Note\\[1\\", "Note\\[1\\]");
        check("Euler \\(e^{i\\", "Euler \\(e^{i\\)");
        check("Opened \\(\\", "Opened");
        // TeX's line break stays.
        check("\\[a \\\\", "\\[a \\\\\\]");
        check("Done \\(x\\) and **b", "Done \\(x\\) and **b**");
        // Inside a formula, markers are TeX's.
        check("\\(a*b", "\\(a*b\\)");
        check("\\(a_1\\) x", "\\(a_1\\) x");
        check("`\\(` code", "`\\(` code");
    }

    #[test]
    fn links_and_tags() {
        check("See [the docs](https://exa", "See the docs");
        check("See [the docs", "See the docs");
        check("See [the docs]", "See [the docs]");
        check("See [a](b) and [c](d", "See [a](b) and c");
        check("An image ![alt](http://x", "An image");
        check("An image ![al", "An image");
        check("Note[^1", "Note");
        check("[", "");
        check("Some <di", "Some");
        check("Some <a href=\"x", "Some");
        check("a < b", "a < b");
        check("Visit <https://exa", "Visit");
        check("<b>x</b>", "<b>x</b>");
        check("`[x`", "`[x`");
    }

    #[test]
    fn tables() {
        check("| a | b |\n| -", "| a | b |\n| --- | --- |");
        check("| a | b |\n|:-", "| a | b |\n| :--- | --- |");
        check("| a | b |\n| --- | --: |", "| a | b |\n| --- | ---: |");
        check("| a | b |\n|", "| a | b |");
        check(
            "| a | b |\n| --- | --- |\n| 1 |",
            "| a | b |\n| --- | --- |\n| 1 |",
        );
        // A pipeless line above: a heading's underline, held until its
        // line ends.
        check("Title\n---", "Title");
        check("Title\n---\n", "Title\n---\n");
    }

    #[test]
    fn held_lines() {
        // A list marker alone: no empty item until its content arrives.
        check("para\n\n-", "para\n\n");
        check("- one\n-", "- one");
        check("- one\n- ", "- one");
        check("1. one\n2.", "1. one");
        check("1. one\n2", "1. one");
        check("> - one\n> -", "> - one");
        check("- **one\n-", "- **one**");
        check("- one\n- t", "- one\n- t");
        // A line of `-` or `=`: no heading until the line ends.
        check("Title\n-", "Title");
        check("Title\n--", "Title");
        check("Title\n==", "Title");
        check("Title\n--\n", "Title\n--\n");
        check("a -- b", "a -- b");
        // Ended, the line means what it says.
        check("- one\n-\n", "- one\n-\n");
    }

    #[test]
    fn fences() {
        // The opening line still arriving: nothing yet.
        check("```pyth", "");
        check("Intro **bold\n```py", "Intro **bold**");
        check("- ```", "");
        // Opened, the block shows as it grows.
        check("```py\n", "```py\n");
        check("```py\nx", "```py\nx");
        // A closer half typed is not code.
        check("```py\nx\n``", "```py\nx");
        check("````\nx\n```", "````\nx");
        check("~~~\nx\n~", "~~~\nx");
        check("```py\nx\n```", "```py\nx\n```");
        check("```py\nx\n``\n", "```py\nx\n``\n");
    }

    #[test]
    fn stars_inside_words() {
        check("a*b", "a*b");
        check("2*3", "2*3");
        check("a*b*", "a*b*");
        check("a *b", "a *b*");
        check("*a*b", "*a*b");
        check("foo**bar", "foo**bar**");
        check("中*粗", "中*粗*");
    }

    #[test]
    fn never_panics() {
        for input in [
            "",
            "*",
            "**",
            "***",
            "_",
            "`",
            "``",
            "$",
            "$$",
            "~~",
            "[",
            "![",
            "<",
            "](",
            "\\",
            "| \n-",
            "中文**粗",
            "**中文",
            "é*",
            "\n\n\n",
            "> ",
            "1. ",
            "- [",
        ] {
            let _ = repair(input);
        }
        check("中文**粗", "中文**粗**");
    }
}
