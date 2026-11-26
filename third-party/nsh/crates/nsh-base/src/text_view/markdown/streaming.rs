//! The end of Markdown still arriving (an AI model's reply, token by
//! token), repaired so syntax it leaves open shows as it will once closed:
//! `**bold` as bold, `` `code `` as code, `[text](htt` as its text, a
//! table's header as a table, instead of the markers as text until the
//! rest arrives. Only the last block is touched: the blocks before it are
//! complete. A last line whose meaning the next characters decide (a list
//! marker or an item's task box alone, a `-` or `=` line that may underline
//! a heading, a fence being opened or closed) is held back until its line
//! ends; a finished document is parsed as written.

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
    let tail_start = match last_block(&source, &mut |_| {}) {
        Last::Block(start) => start,
        Last::Fenced => return source,
        Last::Hold(at) => {
            let keep = source[..at].trim_end().len();
            return repair_mapped(source.slice(0..keep));
        }
    };
    repair_block(source, tail_start)
}

fn repair_block(source: Source, tail_start: usize) -> Source {
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

pub(super) fn repair_tail<'s>(tail: &'s str, blank: &mut dyn FnMut(usize)) -> Option<Cow<'s, str>> {
    repair_plain(tail, true, blank)
}

/// The blank lines of `source` outside its fenced blocks, as the repair's
/// scan reads them: where the line after each starts goes to `blank`.
pub(super) fn blank_lines(source: &str, blank: &mut dyn FnMut(usize)) {
    last_block(source, blank);
}

/// `source` repaired; with `tail`, `None` when the repair would reach the
/// text before `source` ([`repair_tail`]).
fn repair_plain<'s>(
    source: &'s str,
    tail: bool,
    blank: &mut dyn FnMut(usize),
) -> Option<Cow<'s, str>> {
    let start = match last_block(source, blank) {
        Last::Block(start) => start,
        Last::Fenced => return Some(Cow::Borrowed(source)),
        Last::Hold(at) => {
            // The rest is repaired as if the held line had not arrived.
            let kept = source[..at].trim_end();
            if tail && kept.is_empty() {
                return None;
            }
            let repaired = repair_plain(kept, tail, &mut |_| {})?;
            return Some(Cow::Owned(repaired.into_owned()));
        }
    };
    let repaired = repair_block(Source::original(source), start);
    Some(if &*repaired == source {
        Cow::Borrowed(source)
    } else {
        Cow::Owned(repaired.to_string())
    })
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
/// fenced block). `blank` gets where the line after each blank line outside
/// fenced blocks starts.
fn last_block(source: &str, blank: &mut dyn FnMut(usize)) -> Last {
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
            blank(next);
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
/// text later), digits that may become one, an item's task box alone, or a
/// line of `-` or `=` (a heading's underline now; a rule, an item or text
/// later).
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
    // An item's task box alone (`- [`, `- [x`, `- [x]`): an item showing
    // `[x` now, a box once its content arrives.
    let task_box = trimmed.len() < unquoted.len()
        && matches!(trimmed, "[" | "[x" | "[X" | "[ ]" | "[x]" | "[X]");
    let underline = trimmed.bytes().all(|b| matches!(b, b'-' | b' ' | b'\t'))
        || trimmed.bytes().all(|b| b == b'=');
    // Whitespace alone is a blank line once it ends: nothing to hold.
    (!line.trim().is_empty() && (marker || task_box || underline)).then_some(start)
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

/// The code of a text, whose content is left alone: its spans and the
/// opening backtick run nothing closes (`spans`), read by a scan from the
/// text's start to its end. Each question moves a cursor past the spans
/// that end before the byte asked about, so a scan visits every span once
/// rather than searching all of them at each byte: a block of thousands of
/// spans (a long table still arriving) is repaired in time linear in its
/// length.
struct Code {
    spans: Vec<Span>,
    open: Option<Span>,
    /// The first span that may hold a byte not asked about yet.
    next: usize,
}

impl Code {
    /// The code of `text`: its inline code, with `tex` its TeX formulas
    /// (`\\(…\\)`, `\\[…\\]`) too.
    fn of(text: &str, tex: bool) -> Self {
        let (spans, open) = spans(text, tex);
        Self {
            spans,
            open,
            next: 0,
        }
    }

    /// The span holding byte `i`, which is no less than at the call before.
    fn span_at(&mut self, i: usize) -> Option<Span> {
        debug_assert!(
            self.next == 0 || self.spans[self.next - 1].1 <= i,
            "code is read from start to end"
        );
        // The spans are in order and apart: the first that ends after `i` is
        // the only one that may hold it.
        while self.spans.get(self.next).is_some_and(|&(_, end)| end <= i) {
            self.next += 1;
        }
        self.spans
            .get(self.next)
            .copied()
            .filter(|&(start, _)| start <= i)
    }

    /// Whether byte `i`, which is no less than at the call before, is
    /// outside code.
    fn outside(&mut self, i: usize) -> bool {
        self.span_at(i).is_none() && self.open.is_none_or(|(start, _)| i < start)
    }
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

/// A TeX formula left open (`\\(x`, `\\[` and lines of it) closed, or
/// removed while nothing follows its opener.
fn tex(text: &Source) -> Source {
    let mut code = Code::of(text, false);
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !code.outside(i) {
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

/// Links and images not finished: `[text`, `[text]` at the end and
/// `[text](partial` as their text, `![alt`, `![alt]` and `![alt](partial`
/// removed.
fn links(text: &Source) -> Source {
    let mut code = Code::of(text, true);
    let bytes = text.as_bytes();
    // Ranges removed, and for a link whose destination is unfinished the
    // ranges of its syntax.
    let mut remove: Vec<(usize, usize)> = Vec::new();
    let mut brackets: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !code.outside(i) {
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
                let Some(start) = brackets.pop() else {
                    i += 1;
                    continue;
                };
                let image = start > 0 && bytes[start - 1] == b'!';
                if bytes.get(i + 1) == Some(&b'(') && destination_end(bytes, i + 2).is_none() {
                    // The destination runs to the end: drop it.
                    if image {
                        remove.push((start - 1, bytes.len()));
                    } else {
                        remove.push((start, start + 1));
                        remove.push((i, bytes.len()));
                    }
                    brackets.clear();
                    break;
                }
                if i + 1 == bytes.len() && !matches!(bytes.get(start + 1), Some(b'^' | b'!')) {
                    // Closed at the end, where its destination's `(` may
                    // come next: shown as while it was open. A footnote's
                    // reference and an alert's marker (`> [!NOTE]`) are
                    // complete.
                    if image {
                        remove.push((start - 1, bytes.len()));
                    } else {
                        remove.push((start, start + 1));
                        remove.push((i, i + 1));
                    }
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
    let mut code = Code::of(text, true);
    let Some(lt) = text.rfind('<') else {
        return text.clone();
    };
    if !code.outside(lt) || text[lt..].contains('>') || (lt > 0 && text.as_bytes()[lt - 1] == b'\\')
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
    let mut code = Code::of(text, true);
    let open_code = code.open;
    // A run of markers at the end after a space opens nothing yet (`a **`):
    // removed, and so is each run then at the end. A loop, not a call per
    // run: a reply of thousands of runs (`a * * * …`) ran the stack out.
    // The runs hold no backtick, backslash or `)`, so the code of what is
    // left is the code of `text` before it.
    let mut end = text.len();
    loop {
        let trimmed = text[..end].trim_end();
        let run_start = trimmed.trim_end_matches(['*', '_', '~']).len();
        if run_start < trimmed.len()
            && trimmed[..run_start]
                .chars()
                .next_back()
                .is_none_or(char::is_whitespace)
            && open_code.is_none_or(|(s, _)| s > run_start)
        {
            end = trimmed[..run_start].trim_end().len();
        } else {
            break;
        }
    }
    let text = text.slice(0..end);
    let bytes = text.as_bytes();
    let scan_end = open_code.map_or(bytes.len(), |(s, _)| s);
    let mut stack: Vec<(&'static str, usize)> = Vec::new();
    // The run of markers ending the text, when it neither opened nor
    // closed anything: its start, length and marker.
    let mut idle_end = None;
    let mut i = 0;
    while i < scan_end {
        if let Some((start, end)) = code.span_at(i)
            && start == i
        {
            i = end;
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
        let mut closed = false;
        for &token in tokens {
            let open = stack.iter().rposition(|&(t, _)| t == token);
            match open {
                Some(at) if can_close => {
                    stack.remove(at);
                    closed = true;
                }
                _ if can_open => opened.push(token),
                _ => {}
            }
        }
        if i + len == bytes.len() && !closed && opened.is_empty() {
            idle_end = Some((i, len, b));
        }
        // Opening `***`: the strong outside, the emphasis inside.
        for token in opened.into_iter().rev() {
            stack.push((token, i));
        }
        i += len;
    }

    let mut out = text.clone();
    // A closer typed in part (`**bold*`, `~~del~`): a run at the end that
    // did nothing, shorter than an open run of its marker, is the start of
    // that run's closer. Removed, the whole closer is added below; kept,
    // its markers would show as text after it.
    if let Some((at, len, b)) = idle_end
        && stack
            .iter()
            .any(|&(token, _)| token.as_bytes()[0] == b && token.len() > len)
    {
        out.truncate(at);
    }
    // A code span with nothing in it yet: its backticks removed.
    let mut code_closer = None;
    if let Some((s, len)) = open_code {
        // Fewer backticks at the end than opened the span (`` ``a`b` ``)
        // are the start of its closer, likewise.
        let typed = text.bytes().rev().take_while(|&b| b == b'`').count();
        let body_end = text.len() - if typed < len { typed } else { 0 };
        if text[s + len..body_end].trim().is_empty() {
            out.truncate(s);
        } else {
            out.truncate(body_end);
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

    /// Runs of markers at the end are removed one after another without
    /// recursion: a degenerate reply (`a * * * …`) ran the stack out.
    #[test]
    fn many_trailing_marker_runs() {
        let source = format!("a{}", " *".repeat(30_000));
        let repaired = std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || repair(&source).into_owned())
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(repaired, "a");
        check("a ** __ ~~ *", "a");
        check("a **b ** *", "a **b**");
        check("`a ** *", "`a ** *`");
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
        // Closed at the end, the `(` of a destination may follow: its text,
        // as while the label was open.
        check("See [the docs]", "See the docs");
        check("See [the docs] now", "See [the docs] now");
        check("See [a](b) [c]", "See [a](b) c");
        check("[a] [b]", "[a] b");
        check("[a [b]", "a b");
        check("An image ![alt]", "An image");
        check("`[x]`", "`[x]`");
        // A footnote's reference and an alert's marker are complete as
        // they are.
        check("Note[^1]", "Note[^1]");
        check("> [!NOTE]", "> [!NOTE]");
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
        // A task box alone: no item showing `[x` or `[x]` until its
        // content arrives.
        check("- one\n- [", "- one");
        check("- one\n- [x", "- one");
        check("- one\n- [X]", "- one");
        check("- one\n- [ ]", "- one");
        check("- one\n- [x] ", "- one");
        check("1. one\n2. [x]", "1. one");
        check("> - [x", "");
        check("- [x] **", "");
        check("- one\n- [x] t", "- one\n- [x] t");
        check("- [x]\n", "- [x]\n");
        // Not a task box: an item's link, a paragraph's brackets.
        check("- [link", "- link");
        check("[x", "x");
    }

    /// A closer typed in part (`**bold*`): what it will close shows closed,
    /// not a longer closer whose extra markers show as text.
    #[test]
    fn half_typed_closers() {
        check("**bold*", "**bold**");
        check("Some ~~del~", "Some ~~del~~");
        check("__bold_", "__bold__");
        check("Formula $$x$", "Formula $$x$$");
        check("**a ~~b~", "**a ~~b~~**");
        check("``b`c`", "``b`c``");
        check("x ```a`` b`", "x ```a`` b```");
        // A run that closed something stays.
        check("**a *b*", "**a *b***");
        check("***both**", "***both***");
        check("*a* b*", "*a* b*");
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
    fn escaped_and_open_code() {
        // Escaped backticks open no code: the markers after them count.
        check("Use \\`not code\\` and **b", "Use \\`not code\\` and **b**");
        check("\\``a` and **b", "\\``a` and **b**");
        // A backslash inside code escapes nothing.
        check("`a\\` **b", "`a\\` **b**");
        // An escaped backtick before an open span: the span opens after it.
        check("\\`a` and **b", "\\`a` and **b`");
        // An open span after closed ones: what follows it is code.
        check("Use `x` and `open **b", "Use `x` and `open **b`");
        check("Use `x` and `[open", "Use `x` and `[open`");
        check("`a` `b` ``c ` d", "`a` `b` ``c ` d``");
        check("`a` and `", "`a` and");
        check("`a` *b* `", "`a` *b*");
    }

    #[test]
    fn tex_holding_backticks() {
        // A formula's backtick opens no code, whether it is closed or not.
        check("\\(a`b\\) and **c", "\\(a`b\\) and **c**");
        check("Euler \\(a`b", "Euler \\(a`b\\)");
        check("\\(`x` *y", "\\(`x` *y\\)");
        check("\\[\n`a`\n**b", "\\[\n`a`\n**b\n\\]");
        check("\\(x*`y`*z\\) [link](htt", "\\(x*`y`*z\\) link");
        // Code holding a formula's opener: no formula.
        check("`\\(` and \\(x", "`\\(` and \\(x\\)");
        check("`\\[a` **b", "`\\[a` **b**");
    }

    #[test]
    fn links_beside_code() {
        check("`a` [b](htt", "`a` b");
        check("[`a`](htt", "`a`");
        check("`[` [b](c) and [d](e", "`[` [b](c) and d");
        check("[a `]` b](htt", "a `]` b");
        check("`x`![alt](htt", "`x`");
        check("`x`[", "`x`");
        check("[`a` and `b", "`a` and `b`");
        // Multi-byte characters around spans.
        check("中`代码`文 **粗", "中`代码`文 **粗**");
        check("é`a`[链接](htt", "é`a`链接");
        check("`中`\\(公式", "`中`\\(公式\\)");
        check("中文 `代码", "中文 `代码`");
        check("`é`[ü](http", "`é`ü");
        check("`日本` <di", "`日本`");
    }

    #[test]
    fn many_code_spans() {
        let spans = "`a` x ".repeat(2_000);
        // Nothing to repair: the source itself.
        assert!(matches!(repair(&spans), std::borrow::Cow::Borrowed(_)));
        check(&format!("{spans}**b"), &format!("{spans}**b**"));
        check(&format!("{spans}[c](htt"), &format!("{spans}c"));
        check(&format!("{spans}\\(x"), &format!("{spans}\\(x\\)"));
        check(&format!("{spans}`open"), &format!("{spans}`open`"));
        let starred = "`a*b` _ `[` ".repeat(500);
        check(&format!("{starred}*it"), &format!("{starred}*it*"));
        let mut table = String::from("| Name | Type |\n|---|---|\n");
        for n in 0..600 {
            table.push_str(&format!("| `field_{n}` | `Option<u32>` |\n"));
        }
        assert!(matches!(repair(&table), std::borrow::Cow::Borrowed(_)));
        check(
            &format!("{table}| `last` | **b"),
            &format!("{table}| `last` | **b**"),
        );
    }

    /// The cursor answers as a search of all the spans would, whichever
    /// bytes a scan skips.
    #[test]
    fn code_cursor_matches_search() {
        let pieces = [
            "`", "``", "\\", "\\(", "\\)", "\\[", "\\]", "a", " ", "中", "é", "*", "[", "\n",
        ];
        // xorshift from a fixed seed: the same texts on every run.
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut random = move |below: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % below as u64) as usize
        };
        for _ in 0..2_000 {
            let text: String = (0..random(30))
                .map(|_| pieces[random(pieces.len())])
                .collect();
            for tex in [false, true] {
                let (spans, open) = super::spans(&text, tex);
                for stride in 1..=3 {
                    let mut code = super::Code::of(&text, tex);
                    for i in (0..text.len()).step_by(stride) {
                        let holding = spans.iter().copied().find(|&(s, e)| (s..e).contains(&i));
                        let outside = holding.is_none() && open.is_none_or(|(s, _)| i < s);
                        assert_eq!(code.span_at(i), holding, "{text:?} at {i}");
                        assert_eq!(code.outside(i), outside, "{text:?} at {i}");
                    }
                }
            }
        }
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
