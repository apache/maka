/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Undoing one tracked edit on a file's text, exactly, and redoing it: the
//! unified diffs Maka's `Edit`, `FormatJson` and `Write` return
//! (`createUnifiedDiff`, `createEditUnifiedDiff` in
//! packages/runtime/src/unified-diff.ts), and the V4A sections of
//! `apply_patch`'s `update_file`, which the Host applies with `applyDiff`
//! (`@openai/agents-core` `utils/applyDiff`, ported here).
//!
//! Undoing never guesses: a unified hunk must find its new side, line for
//! line, where its header says and leave its old side where its header
//! says; a V4A section must find its new side unchanged after its anchors,
//! and the text it gives back must turn into the text it was given when the
//! section is applied again the Host's way. Anything else is `None`.

/// A text as Maka's unified diffs number it: split on `\n` (a `\r` stays
/// part of its line), a last line end not starting an empty line
/// (`splitLines`); and whether the text ends with a line end, which those
/// diffs do not show.
pub(crate) fn split_lines(text: &str) -> (Vec<&str>, bool) {
    if text.is_empty() {
        return (Vec::new(), false);
    }
    match text.strip_suffix('\n') {
        Some(body) => (body.split('\n').collect(), true),
        None => (text.split('\n').collect(), false),
    }
}

/// The text of `lines`, ending with a line end when `ends`.
pub(crate) fn join_lines<S: AsRef<str>>(lines: &[S], ends: bool) -> String {
    let mut text = String::new();
    for (ix, line) in lines.iter().enumerate() {
        if ix > 0 {
            text.push('\n');
        }
        text.push_str(line.as_ref());
    }
    if ends && !lines.is_empty() {
        text.push('\n');
    }
    text
}

/// One hunk of a unified diff: where its sides start (1-based; the line
/// before them when they are empty) and their lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hunk {
    pub(crate) old_start: usize,
    pub(crate) new_start: usize,
    pub(crate) old: Vec<String>,
    pub(crate) new: Vec<String>,
}

/// `@@ -a[,b] +c[,d] @@`: the starts and the lengths.
fn hunk_header(line: &str) -> Option<(usize, usize, usize, usize)> {
    let body = line.strip_prefix("@@ -")?;
    let (ranges, _) = body.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |range: &str| -> Option<(usize, usize)> {
        match range.split_once(',') {
            Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (old_start, old_len) = range(old)?;
    let (new_start, new_len) = range(new)?;
    Some((old_start, old_len, new_start, new_len))
}

/// The hunks of a unified diff, their lines read by the counts their
/// headers declare (a removed `-- a` is a removal, not a file header);
/// `None` for a diff whose hunks are cut short or hold a line that is not
/// one.
pub(crate) fn parse_hunks(diff: &str) -> Option<Vec<Hunk>> {
    let mut hunks = Vec::new();
    let mut lines = diff.split('\n').peekable();
    while let Some(line) = lines.next() {
        let Some((old_start, mut old_left, new_start, mut new_left)) = hunk_header(line) else {
            continue;
        };
        let mut hunk = Hunk { old_start, new_start, old: Vec::new(), new: Vec::new() };
        while old_left + new_left > 0 {
            let line = lines.next()?;
            match line.as_bytes().first() {
                Some(b'\\') => {}
                Some(b'-') if old_left > 0 => {
                    hunk.old.push(line[1..].to_owned());
                    old_left -= 1;
                }
                Some(b'+') if new_left > 0 => {
                    hunk.new.push(line[1..].to_owned());
                    new_left -= 1;
                }
                Some(b' ') | None if old_left > 0 && new_left > 0 => {
                    let text = line.get(1..).unwrap_or("").to_owned();
                    hunk.old.push(text.clone());
                    hunk.new.push(text);
                    old_left -= 1;
                    new_left -= 1;
                }
                _ => return None,
            }
        }
        // A note for the last line belongs to the hunk.
        lines.next_if(|line| line.starts_with('\\'));
        hunks.push(hunk);
    }
    Some(hunks)
}

/// Where a side of a hunk starts as a 0-based index.
fn side_start(start: usize, len: usize) -> Option<usize> {
    if len == 0 { Some(start) } else { start.checked_sub(1) }
}

/// `after` as it was before `diff`: each hunk's new side found where its
/// header puts it and its old side put back, the old side landing where
/// its header puts it. The line end at the end of the text stays as it is.
pub(crate) fn unapply_unified(after: &str, diff: &str) -> Option<String> {
    let hunks = parse_hunks(diff)?;
    let (lines, ends) = split_lines(after);
    let mut before: Vec<&str> = Vec::with_capacity(lines.len());
    let mut cursor = 0;
    for hunk in &hunks {
        let at = side_start(hunk.new_start, hunk.new.len())?;
        if at < cursor || lines.get(at..at + hunk.new.len())? != hunk.new.as_slice() {
            return None;
        }
        before.extend_from_slice(&lines[cursor..at]);
        if before.len() != side_start(hunk.old_start, hunk.old.len())? {
            return None;
        }
        before.extend(hunk.old.iter().map(String::as_str));
        cursor = at + hunk.new.len();
    }
    before.extend_from_slice(&lines[cursor..]);
    Some(join_lines(&before, ends))
}

/// `before` with `diff` applied: each hunk's old side found where its
/// header puts it and replaced by its new side.
pub(crate) fn apply_unified(before: &str, diff: &str) -> Option<String> {
    let hunks = parse_hunks(diff)?;
    let (lines, ends) = split_lines(before);
    let mut after: Vec<&str> = Vec::with_capacity(lines.len());
    let mut cursor = 0;
    for hunk in &hunks {
        let at = side_start(hunk.old_start, hunk.old.len())?;
        if at < cursor || lines.get(at..at + hunk.old.len())? != hunk.old.as_slice() {
            return None;
        }
        after.extend_from_slice(&lines[cursor..at]);
        after.extend(hunk.new.iter().map(String::as_str));
        cursor = at + hunk.old.len();
    }
    after.extend_from_slice(&lines[cursor..]);
    Some(join_lines(&after, ends))
}

const END_PATCH: &str = "*** End Patch";
const END_FILE: &str = "*** End of File";
const END_SECTION_MARKERS: [&str; 5] =
    [END_PATCH, "*** Update File:", "*** Delete File:", "*** Add File:", END_FILE];

/// One change inside a V4A section: at `at` lines into the section's
/// context, `removed` lines replaced by `inserted` ones.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Chunk {
    at: usize,
    removed: Vec<String>,
    inserted: Vec<String>,
}

/// A V4A section (`readAnchors` and `readSection`): its anchors, the lines
/// it finds (kept and removed, in order), its changes, and whether it is
/// at the file's end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Section {
    /// Every `@@` line counted; only the ones with text are searched.
    anchor_count: usize,
    anchors: Vec<String>,
    context: Vec<String>,
    chunks: Vec<Chunk>,
    eof: bool,
}

impl Section {
    /// The lines the section leaves in place of its context.
    fn replacement(&self) -> Vec<&str> {
        let mut lines = Vec::new();
        let mut ix = 0;
        for chunk in &self.chunks {
            lines.extend(self.context[ix..chunk.at].iter().map(String::as_str));
            lines.extend(chunk.inserted.iter().map(String::as_str));
            ix = chunk.at + chunk.removed.len();
        }
        lines.extend(self.context[ix..].iter().map(String::as_str));
        lines
    }

    /// Lines the section inserts and removes.
    #[cfg(test)]
    pub(crate) fn counts(&self) -> (u32, u32) {
        let count = |pick: fn(&Chunk) -> usize| {
            u32::try_from(self.chunks.iter().map(pick).sum::<usize>()).unwrap_or(u32::MAX)
        };
        (count(|chunk| chunk.inserted.len()), count(|chunk| chunk.removed.len()))
    }

    /// The lines it finds and the lines it leaves, for a diff of it alone.
    pub(crate) fn sides(&self) -> (Vec<String>, Vec<String>) {
        (self.context.clone(), self.replacement().into_iter().map(str::to_owned).collect())
    }
}

/// `normalizeDiffLines`: split on line ends, a `\r` before one dropped,
/// and a last empty line dropped.
fn diff_lines(diff: &str) -> Vec<String> {
    let mut lines: Vec<String> =
        diff.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned()).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

/// The sections of a V4A update, or `None` where `applyDiff` would throw
/// before it reads the file.
pub(crate) fn parse_sections(diff: &str) -> Option<Vec<Section>> {
    let mut lines = diff_lines(diff);
    lines.push(END_PATCH.to_owned());
    let mut ix = 0;
    let done = |ix: usize, lines: &[String]| {
        ix >= lines.len() || END_SECTION_MARKERS.iter().any(|marker| lines[ix].starts_with(marker))
    };
    let mut sections = Vec::new();
    while !done(ix, &lines) {
        let (mut anchor_count, mut anchors) = (0, Vec::new());
        loop {
            let line = &lines[ix];
            if let Some(anchor) = line.strip_prefix("@@ ") {
                if !anchor.trim().is_empty() {
                    anchors.push(anchor.to_owned());
                }
            } else if line != "@@" {
                break;
            }
            anchor_count += 1;
            ix += 1;
        }
        let (section, next) = read_section(&lines, ix)?;
        sections.push(Section { anchor_count, anchors, ..section });
        ix = next;
    }
    Some(sections)
}

/// `readSection`: the lines from `start` to the next section.
fn read_section(lines: &[String], start: usize) -> Option<(Section, usize)> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Keep,
        Add,
        Delete,
    }
    let mut section = Section {
        anchor_count: 0,
        anchors: Vec::new(),
        context: Vec::new(),
        chunks: Vec::new(),
        eof: false,
    };
    let (mut removed, mut inserted) = (Vec::new(), Vec::new());
    let mut mode = Mode::Keep;
    let mut ix = start;
    while ix < lines.len() {
        let raw = lines[ix].as_str();
        if raw.starts_with("@@")
            || raw.starts_with(END_PATCH)
            || raw.starts_with("*** Update File:")
            || raw.starts_with("*** Delete File:")
            || raw.starts_with("*** Add File:")
            || raw.starts_with(END_FILE)
            || raw == "***"
        {
            break;
        }
        if raw.starts_with("***") {
            return None;
        }
        ix += 1;
        let last = mode;
        let line = if raw.is_empty() { " " } else { raw };
        mode = match line.as_bytes()[0] {
            b'+' => Mode::Add,
            b'-' => Mode::Delete,
            b' ' => Mode::Keep,
            _ => return None,
        };
        let text = line[1..].to_owned();
        if mode == Mode::Keep && last != mode && (!inserted.is_empty() || !removed.is_empty()) {
            section.chunks.push(Chunk {
                at: section.context.len() - removed.len(),
                removed: std::mem::take(&mut removed),
                inserted: std::mem::take(&mut inserted),
            });
        }
        match mode {
            Mode::Delete => {
                removed.push(text.clone());
                section.context.push(text);
            }
            Mode::Add => inserted.push(text),
            Mode::Keep => section.context.push(text),
        }
    }
    if !inserted.is_empty() || !removed.is_empty() {
        section.chunks.push(Chunk {
            at: section.context.len() - removed.len(),
            removed: std::mem::take(&mut removed),
            inserted: std::mem::take(&mut inserted),
        });
    }
    if lines.get(ix).is_some_and(|line| line == END_FILE) {
        section.eof = true;
        return Some((section, ix + 1));
    }
    (ix != start).then_some((section, ix))
}

/// `updateLineEnding`: `\r\n` when every line end of `text` has a `\r`
/// before it (and it has one), else `\n`.
fn line_ending(text: &str) -> &'static str {
    let bytes = text.as_bytes();
    let mut any = false;
    for (ix, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            any = true;
            if ix == 0 || bytes[ix - 1] != b'\r' {
                return "\n";
            }
        }
    }
    if any { "\r\n" } else { "\n" }
}

/// `advanceCursorToAnchor`: the cursor past the anchor's line, found as it
/// is, then trimmed; an anchor already passed leaves it.
fn advance_to_anchor(
    anchor: &str,
    lines: &[&str],
    mut cursor: usize,
    require: bool,
    forward_only: bool,
) -> Option<usize> {
    let cursor_at = cursor.min(lines.len());
    let mut found = !forward_only && lines[..cursor_at].contains(&anchor);
    if !found && let Some(ix) = (cursor..lines.len()).find(|ix| lines[*ix] == anchor) {
        cursor = ix + 1;
        found = true;
    }
    if !found {
        let trimmed = anchor.trim();
        found = !forward_only && lines[..cursor_at].iter().any(|line| line.trim() == trimmed);
        if !found && let Some(ix) = (cursor..lines.len()).find(|ix| lines[*ix].trim() == trimmed) {
            cursor = ix + 1;
            found = true;
        }
    }
    (found || !require).then_some(cursor)
}

/// `findContextCore`: the first place from `start` where `context` is,
/// exactly, then with line ends trimmed, then trimmed.
fn find_context_core<S: AsRef<str>>(lines: &[&str], context: &[S], start: usize) -> Option<usize> {
    if context.is_empty() {
        return Some(start);
    }
    let fits = |ix: usize, same: &dyn Fn(&str, &str) -> bool| {
        ix + context.len() <= lines.len()
            && context
                .iter()
                .enumerate()
                .all(|(offset, line)| same(lines[ix + offset], line.as_ref()))
    };
    let exact = |a: &str, b: &str| a == b;
    let trim_end = |a: &str, b: &str| a.trim_end() == b.trim_end();
    let trim = |a: &str, b: &str| a.trim() == b.trim();
    for same in [&exact as &dyn Fn(&str, &str) -> bool, &trim_end, &trim] {
        if let Some(ix) = (start..lines.len()).find(|ix| fits(*ix, same)) {
            return Some(ix);
        }
    }
    None
}

/// `findContext`: at the file's end first for a section marked so.
fn find_context(lines: &[&str], context: &[String], start: usize, eof: bool) -> Option<usize> {
    if !eof {
        return find_context_core(lines, context, start);
    }
    let search = if lines.len() > 1 && lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        lines
    };
    let end_start = search.len().saturating_sub(context.len());
    find_context_core(search, context, end_start)
        .or_else(|| find_context_core(search, context, start.min(search.len())))
}

/// `text` with `diff`, a V4A update, applied as the Host applies it
/// (`applyDiff` in default mode), or `None` where it would throw.
pub(crate) fn apply_patch(text: &str, diff: &str) -> Option<String> {
    let sections = parse_sections(diff)?;
    let ending = line_ending(text);
    let normalized = if ending == "\r\n" { text.replace("\r\n", "\n") } else { text.to_owned() };
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut chunks: Vec<(usize, &Chunk)> = Vec::new();
    let mut cursor = 0;
    for section in &sections {
        if section.anchor_count == 0 && cursor != 0 {
            return None;
        }
        let require = section.anchor_count > 1;
        for (ix, anchor) in section.anchors.iter().enumerate() {
            cursor = advance_to_anchor(anchor, &lines, cursor, require, ix > 0)?;
        }
        let at = find_context(&lines, &section.context, cursor, section.eof)?;
        chunks.extend(section.chunks.iter().map(|chunk| (chunk.at + at, chunk)));
        cursor = at + section.context.len();
    }
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut ix = 0;
    for (at, chunk) in chunks {
        if at > lines.len() || ix > at {
            return None;
        }
        out.extend_from_slice(&lines[ix..at]);
        out.extend(chunk.inserted.iter().map(String::as_str));
        ix = at + chunk.removed.len();
    }
    out.extend_from_slice(&lines[ix.min(lines.len())..]);
    Some(out.join(ending))
}

/// `after` as it was before `diff`, a V4A update: each section's new side
/// found, unchanged, after its anchors (at the file's end first for a
/// section marked so) and its old side put back; the result must give
/// `after` again when the section is applied the Host's way.
pub(crate) fn unapply_patch(after: &str, diff: &str) -> Option<String> {
    let sections = parse_sections(diff)?;
    let ending = line_ending(after);
    let normalized = if ending == "\r\n" { after.replace("\r\n", "\n") } else { after.to_owned() };
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut before: Vec<&str> = Vec::with_capacity(lines.len());
    let (mut copied, mut cursor) = (0, 0);
    for section in &sections {
        if section.anchor_count == 0 && cursor != 0 {
            return None;
        }
        let require = section.anchor_count > 1;
        for (ix, anchor) in section.anchors.iter().enumerate() {
            cursor = advance_to_anchor(anchor, &lines, cursor, require, ix > 0)?;
        }
        let replacement = section.replacement();
        let at = exact_place(&lines, &replacement, cursor, section.eof)?;
        if at < copied {
            return None;
        }
        before.extend_from_slice(&lines[copied..at]);
        before.extend(section.context.iter().map(String::as_str));
        copied = at + replacement.len();
        cursor = copied;
    }
    before.extend_from_slice(&lines[copied.min(lines.len())..]);
    let before = before.join(ending);
    (apply_patch(&before, diff).as_deref() == Some(after)).then_some(before)
}

/// Where `wanted` is, exactly, from `start`; at the file's end first for a
/// section marked so.
fn exact_place(lines: &[&str], wanted: &[&str], start: usize, eof: bool) -> Option<usize> {
    let at = |from: usize, lines: &[&str]| {
        if wanted.is_empty() {
            return Some(from);
        }
        (from..lines.len()).find(|ix| lines.get(*ix..*ix + wanted.len()) == Some(wanted))
    };
    if !eof {
        return at(start, lines);
    }
    let search = if lines.len() > 1 && lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        lines
    };
    at(search.len().saturating_sub(wanted.len()), search)
        .or_else(|| at(start.min(search.len()), search))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEFORE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

    #[test]
    fn a_unified_diff_comes_off_and_goes_back_on_exactly() {
        // Maka's Edit diff: three lines of context, no line end at its end.
        let diff =
            "--- a//w/f\n+++ b//w/f\n@@ -2,5 +2,5 @@\n two\n three\n-four\n+FOUR\n five\n six";
        let after = "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n";
        assert_eq!(apply_unified(BEFORE, diff).as_deref(), Some(after));
        assert_eq!(unapply_unified(after, diff).as_deref(), Some(BEFORE));
        // A line the diff does not expect where it says: no guess.
        assert_eq!(unapply_unified(BEFORE, diff), None);
        assert_eq!(unapply_unified("one\ntwo\nthree\nFOUR\nfive\nSIX\nseven\n", diff), None);
        // A new file, and a file emptied.
        let created = "--- /dev/null\n+++ b//w/n\n@@ -0,0 +1,2 @@\n+a\n+b";
        assert_eq!(unapply_unified("a\nb\n", created).as_deref(), Some(""));
        let emptied = "--- a//w/n\n+++ b//w/n\n@@ -1,2 +0,0 @@\n-a\n-b";
        assert_eq!(unapply_unified("", emptied).as_deref(), Some("a\nb"));
    }

    #[test]
    fn a_removed_line_that_looks_like_a_header_is_still_removed() {
        let diff = "@@ -1,2 +1,1 @@\n--- a\n keep";
        assert_eq!(unapply_unified("keep", diff).as_deref(), Some("-- a\nkeep"));
    }

    #[test]
    fn crlf_lines_keep_their_carriage_returns() {
        let diff = "@@ -1,2 +1,2 @@\n-a\r\n+b\r\n c\r";
        assert_eq!(unapply_unified("b\r\nc\r\n", diff).as_deref(), Some("a\r\nc\r\n"));
    }

    #[test]
    fn a_v4a_section_comes_off_and_goes_back_on_the_hosts_way() {
        let diff = "@@ three\n four\n-five\n+FIVE\n+5\n six";
        let after = "one\ntwo\nthree\nfour\nFIVE\n5\nsix\nseven\n";
        assert_eq!(apply_patch(BEFORE, diff).as_deref(), Some(after));
        assert_eq!(unapply_patch(after, diff).as_deref(), Some(BEFORE));
        assert_eq!(unapply_patch(BEFORE, diff), None, "its new side is not there");
        let section = &parse_sections(diff).expect("sections")[0];
        assert_eq!(section.counts(), (2, 1));
    }

    #[test]
    fn v4a_sections_at_the_end_and_in_crlf_files() {
        let diff = " six\n-seven\n+SEVEN\n*** End of File";
        let after = "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n";
        assert_eq!(apply_patch(BEFORE, diff).as_deref(), Some(after));
        assert_eq!(unapply_patch(after, diff).as_deref(), Some(BEFORE));
        let crlf = BEFORE.replace('\n', "\r\n");
        let crlf_after = apply_patch(&crlf, "@@\n one\n-two\n+2").expect("applies");
        assert_eq!(crlf_after, crlf.replace("two", "2"));
        assert_eq!(
            unapply_patch(&crlf_after, "@@\n one\n-two\n+2").as_deref(),
            Some(crlf.as_str())
        );
    }

    #[test]
    fn two_sections_come_off_in_order() {
        let diff = "@@\n one\n-two\n+2\n@@ five\n six\n-seven\n+7";
        let after = apply_patch(BEFORE, diff).expect("applies");
        assert_eq!(after, "one\n2\nthree\nfour\nfive\nsix\n7\n");
        assert_eq!(unapply_patch(&after, diff).as_deref(), Some(BEFORE));
    }
}
