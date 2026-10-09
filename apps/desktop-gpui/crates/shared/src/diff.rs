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

//! Unified diffs read as Maka Desktop reads them
//! (`packages/core/src/unified-diff.ts`): the lines they add and remove,
//! and a cut to a display budget that the kit's Diff component still
//! parses. No GPUI, no I/O.
//!
//! Inside a hunk the declared counts decide what a line is, not its first
//! characters: a removed SQL comment `-- a` arrives as `--- a` and is still
//! a removal, which prefix matching would take for a file header.

/// A side of a diff: the source before the change or after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffSide {
    Old,
    New,
}

/// A diff cut to a number of lines ([`bounded`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BoundedDiff {
    /// The diff, or its first lines with the hunk the cut ends in
    /// re-headed to the lines it keeps.
    pub text: String,
    /// Lines of the diff past the cut (Desktop's `hiddenLines`).
    pub hidden_lines: usize,
    /// The last source line the cut keeps, on the side it belongs to: a
    /// removed line is on the old side, an added or context line on the
    /// new one. `None` when nothing was cut or no hunk line was kept.
    pub last_line: Option<(DiffSide, u32)>,
}

/// How a diff lays out in a unified view without file headers or folding:
/// one separator per hunk, one row per line of a hunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct DiffRows {
    pub hunks: usize,
    pub rows: usize,
}

/// Where a diff's hunks sit in its file ([`extent`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct DiffExtent {
    pub hunks: usize,
    /// Where the first hunk starts on the new side (on the old side for a
    /// file the diff deletes), 1-based; 0 without a hunk.
    pub first_line: u32,
    /// The last source line of the last hunk, on the side it belongs to: a
    /// removed line is on the old side, an added or context line on the new
    /// one.
    pub last_line: Option<(DiffSide, u32)>,
    /// The unchanged lines after the last hunk's last change.
    pub trailing_context: usize,
}

/// A hunk header `@@ -a[,b] +c[,d] @@ rest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HunkHeader<'a> {
    old_start: u32,
    old_len: u32,
    new_start: u32,
    new_len: u32,
    /// Everything after the second `@@`, the section heading included.
    rest: &'a str,
}

fn hunk_header(line: &str) -> Option<HunkHeader<'_>> {
    let body = line.strip_prefix("@@ -")?;
    let (ranges, rest) = body.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |range: &str| -> Option<(u32, u32)> {
        match range.split_once(',') {
            Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (old_start, old_len) = range(old)?;
    let (new_start, new_len) = range(new)?;
    Some(HunkHeader { old_start, old_len, new_start, new_len, rest })
}

/// The kind of a line inside a hunk body, by its first character; a bare
/// empty line is context, as some generators write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyLine {
    Removed,
    Added,
    Context,
    /// `\ No newline at end of file`: annotates the line before it and
    /// takes no line on either side.
    Note,
}

fn body_line(line: &str) -> BodyLine {
    match line.as_bytes().first() {
        Some(b'\\') => BodyLine::Note,
        Some(b'-') => BodyLine::Removed,
        Some(b'+') => BodyLine::Added,
        _ => BodyLine::Context,
    }
}

/// Walks a diff's lines, telling `visit` what each one is: a hunk header,
/// a hunk body line, or anything else (file headers, `diff --git`).
fn scan<'a>(diff: &'a str, mut visit: impl FnMut(&'a str, Scanned<'a>) -> bool) {
    let (mut old_left, mut new_left) = (0u32, 0u32);
    for piece in diff.split_inclusive('\n') {
        let line = piece.strip_suffix('\n').unwrap_or(piece);
        let line = line.strip_suffix('\r').unwrap_or(line);
        let scanned = if old_left + new_left > 0 {
            let kind = body_line(line);
            match kind {
                BodyLine::Removed => old_left = old_left.saturating_sub(1),
                BodyLine::Added => new_left = new_left.saturating_sub(1),
                BodyLine::Context => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
                BodyLine::Note => {}
            }
            Scanned::Body(kind)
        } else if let Some(header) = hunk_header(line) {
            (old_left, new_left) = (header.old_len, header.new_len);
            Scanned::Hunk(header)
        } else {
            Scanned::Other
        };
        if !visit(piece, scanned) {
            break;
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Scanned<'a> {
    Hunk(HunkHeader<'a>),
    Body(BodyLine),
    Other,
}

/// Lines added and removed, counted inside hunks only, as Desktop's
/// `countDiffLineStats` counts them: file headers and a `\ No newline`
/// note are never counted.
pub fn line_counts(diff: &str) -> (u32, u32) {
    let (mut added, mut removed) = (0u32, 0u32);
    scan(diff, |_, scanned| {
        match scanned {
            Scanned::Body(BodyLine::Added) => added += 1,
            Scanned::Body(BodyLine::Removed) => removed += 1,
            _ => {}
        }
        true
    });
    (added, removed)
}

/// The hunks and the rows of their lines.
pub fn display_rows(diff: &str) -> DiffRows {
    let mut rows = DiffRows::default();
    scan(diff, |_, scanned| {
        match scanned {
            Scanned::Hunk(_) => rows.hunks += 1,
            Scanned::Body(BodyLine::Note) | Scanned::Other => {}
            Scanned::Body(_) => rows.rows += 1,
        }
        true
    });
    rows
}

/// Where `diff`'s hunks sit: how many there are, where the first starts,
/// its last line and the unchanged lines after its last change, from which
/// a reader can tell whether the diff carries its file's start and end.
pub fn extent(diff: &str) -> DiffExtent {
    let mut extent = DiffExtent::default();
    let mut at: Option<(HunkHeader<'_>, u32, u32)> = None;
    scan(diff, |_, scanned| {
        match scanned {
            Scanned::Hunk(header) => {
                if extent.hunks == 0 {
                    extent.first_line =
                        if header.new_len > 0 { header.new_start } else { header.old_start };
                }
                extent.hunks += 1;
                extent.trailing_context = 0;
                at = Some((header, 0, 0));
            }
            Scanned::Body(kind) => {
                if let Some((header, old, new)) = at.as_mut() {
                    match kind {
                        BodyLine::Removed => {
                            extent.last_line = Some((DiffSide::Old, header.old_start + *old));
                            extent.trailing_context = 0;
                            *old += 1;
                        }
                        BodyLine::Added => {
                            extent.last_line = Some((DiffSide::New, header.new_start + *new));
                            extent.trailing_context = 0;
                            *new += 1;
                        }
                        BodyLine::Context => {
                            extent.last_line = Some((DiffSide::New, header.new_start + *new));
                            extent.trailing_context += 1;
                            *old += 1;
                            *new += 1;
                        }
                        BodyLine::Note => {}
                    }
                }
            }
            Scanned::Other => at = None,
        }
        true
    });
    extent
}

/// The first `max_lines` lines of `diff`, as Desktop's `capLines` keeps
/// them for display, still a diff a parser takes: a hunk the cut ends in is
/// re-headed to the lines it keeps. A diff within the budget comes back
/// whole.
pub fn bounded(diff: &str, max_lines: usize) -> BoundedDiff {
    let total = diff.split_inclusive('\n').count();
    if total <= max_lines {
        return BoundedDiff { text: diff.to_owned(), hidden_lines: 0, last_line: None };
    }
    let mut kept: Vec<String> = Vec::with_capacity(max_lines);
    // The open hunk: where its header sits in `kept`, the header, and the
    // lines kept on each side so far.
    let mut hunk: Option<(usize, HunkHeader<'_>, u32, u32)> = None;
    let mut last_line = None;
    scan(diff, |piece, scanned| {
        if kept.len() == max_lines {
            return false;
        }
        match scanned {
            Scanned::Hunk(header) => hunk = Some((kept.len(), header, 0, 0)),
            Scanned::Body(kind) => {
                if let Some((_, header, old, new)) = hunk.as_mut() {
                    match kind {
                        BodyLine::Removed => {
                            last_line = Some((DiffSide::Old, header.old_start + *old));
                            *old += 1;
                        }
                        BodyLine::Added => {
                            last_line = Some((DiffSide::New, header.new_start + *new));
                            *new += 1;
                        }
                        BodyLine::Context => {
                            last_line = Some((DiffSide::New, header.new_start + *new));
                            *old += 1;
                            *new += 1;
                        }
                        BodyLine::Note => {}
                    }
                }
            }
            Scanned::Other => hunk = None,
        }
        kept.push(piece.to_owned());
        true
    });
    if let Some((at, header, old, new)) = hunk
        && (old, new) != (header.old_len, header.new_len)
    {
        let newline = if kept[at].ends_with('\n') { "\n" } else { "" };
        kept[at] = format!(
            "@@ -{},{old} +{},{new} @@{}{newline}",
            header.old_start, header.new_start, header.rest
        );
    }
    BoundedDiff { text: kept.concat(), hidden_lines: total - max_lines, last_line }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_HUNKS: &str = "--- a/src/lib.rs\n+++ b/src/lib.rs\n\
        @@ -1,3 +1,3 @@ fn main()\n a\n-b\n+B\n c\n\
        @@ -10,2 +10,3 @@\n x\n+y\n z\n";

    #[test]
    fn the_extent_finds_the_first_and_last_lines() {
        assert_eq!(
            extent(TWO_HUNKS),
            DiffExtent {
                hunks: 2,
                first_line: 1,
                last_line: Some((DiffSide::New, 12)),
                trailing_context: 1
            }
        );
        let deleted = "--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
        let extent = extent(deleted);
        assert_eq!((extent.first_line, extent.last_line), (1, Some((DiffSide::Old, 2))));
        assert_eq!(super::extent("").hunks, 0);
    }

    #[test]
    fn counts_and_rows_come_from_the_hunks() {
        assert_eq!(line_counts(TWO_HUNKS), (2, 1));
        assert_eq!(display_rows(TWO_HUNKS), DiffRows { hunks: 2, rows: 7 });
        // Inside a hunk a header-like line is content.
        let sql = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- a\n x\n";
        assert_eq!(line_counts(sql), (0, 1));
        assert_eq!(line_counts("+++ b/x\n--- a/x\n"), (0, 0), "headers are not lines");
        let queue = "--- a/queue.rs\n+++ b/queue.rs\n@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+more\n keep\n\\ No newline at end of file\n@@ -10 +11,0 @@\n-gone\n";
        assert_eq!(line_counts(queue), (2, 2));
        assert_eq!(
            hunk_header("@@ -3 +3,2 @@ fn main").map(|h| (h.old_len, h.new_len)),
            Some((1, 2))
        );
        assert_eq!(hunk_header("@@ bogus @@"), None);
        let note = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
        assert_eq!(line_counts(note), (1, 1));
        assert_eq!(display_rows(note).rows, 2, "the note takes no row");
    }

    #[test]
    fn a_diff_within_the_budget_comes_back_whole() {
        let bounded = bounded(TWO_HUNKS, 12);
        assert_eq!(bounded.text, TWO_HUNKS);
        assert_eq!((bounded.hidden_lines, bounded.last_line), (0, None));
    }

    #[test]
    fn a_cut_re_heads_the_hunk_it_ends_in() {
        // Six lines: both file headers, the first hunk's header and three
        // of its four lines.
        let bounded = bounded(TWO_HUNKS, 6);
        assert_eq!(
            bounded.text,
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@ fn main()\n a\n-b\n+B\n"
        );
        assert_eq!(bounded.hidden_lines, 5);
        assert_eq!(bounded.last_line, Some((DiffSide::New, 2)));
        assert_eq!(line_counts(&bounded.text), (1, 1));

        // A cut at a hunk's end keeps its header; the next one goes.
        let whole_hunk = super::bounded(TWO_HUNKS, 7);
        assert!(whole_hunk.text.contains("@@ -1,3 +1,3 @@ fn main()"));
        assert_eq!(whole_hunk.last_line, Some((DiffSide::New, 3)));

        // A removal is on the old side.
        let removal = super::bounded("@@ -4,3 +4,1 @@\n-a\n-b\n-c\n+d\n", 3);
        assert_eq!(removal.text, "@@ -4,2 +4,0 @@\n-a\n-b\n");
        assert_eq!(removal.last_line, Some((DiffSide::Old, 5)));
    }
}
