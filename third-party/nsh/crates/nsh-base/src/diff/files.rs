//! The files of a patch: each file's texts diffed on their own, then joined
//! into the view's two sides, so the rows, cells, highlighting and ref work
//! on one pair of texts as they do for one file; each file shows under a
//! header row (`Row::File`) and collapses to it.
//!
//! How indexes stay coherent across files:
//!
//! - **Lines.** File `i`'s lines start at its `old_at` / `new_at` in the
//!   joined texts; each file's text ends with a line break there, so no
//!   two files share a line. Each side numbers its lines as in the files
//!   (`Side::numbers`, one entry per hunk of every file).
//! - **Hunks.** The joined model's hunks are the files' in order, file `i`'s
//!   being `first_hunk..first_hunk + hunks`: `DiffHunk::index`, `goToHunk`
//!   and `renderHunkActions` count across files, and `DiffHunk`'s lines are
//!   given back in its file's texts (`localize`). The stats are the sum of
//!   the files'.
//! - **Hunk headers.** Their separators' `gap` counts across files.
//!
//! Each file is highlighted with its own language (a [`Segment`] per file
//! and side), so a file's syntax state never runs into the next file's.

use std::{collections::HashSet, ops::Range};

use nsh_core::prelude::*;
use ropey::Rope;

use super::{
    DiffFile, DiffFileStatus, DiffHunk, DiffViewPart,
    controller::Dv,
    layout::{self, Expansions, Header, Layout, Options, Row},
    model::{self, DiffModel, Hunk},
    patch::{self, FilePatch},
    view::{ADDED, DELETED, PAD, part},
};
use crate::{
    editor::{
        highlight::{
            Done, GUESS_CONTEXT, GUESS_DISTANCE, Guess, Guessed, Highlighter, Job, LOOKAHEAD,
            SLICE, Syntax,
        },
        languages,
    },
    syntax::Token,
    theme,
};

/// The lines of one file on one side, highlighted with its file's language.
pub(crate) struct Segment {
    /// Its first line in the joined text.
    first: usize,
    /// How many lines it has.
    lines: usize,
    rope: Rope,
    /// What highlights its file's language.
    syntax: Syntax,
    highlighter: Option<Highlighter>,
}

impl Segment {
    fn new(first: usize, text: &str, syntax: Syntax) -> Segment {
        Segment {
            first,
            lines: model::line_starts(text).len(),
            rope: Rope::from_str(text),
            syntax,
            highlighter: None,
        }
    }
}

/// Whether any of `segments` has a language to highlight.
pub(crate) fn hinted(segments: &[Segment]) -> bool {
    segments.iter().any(|s| !s.syntax.is_plain())
}

/// Whether the segments' highlighters can be made (the built-in
/// syntaxes are loaded, where one needs them).
pub(crate) fn ready(segments: &[Segment]) -> bool {
    segments.iter().all(|s| s.syntax.ready())
}

/// Makes the segments' highlighters (none until their syntaxes are
/// ready).
pub(crate) fn make_highlighters(segments: &mut [Segment]) {
    for segment in segments {
        segment.highlighter = segment
            .syntax
            .ready()
            .then(|| Highlighter::with(&segment.syntax))
            .flatten();
    }
}

/// The tokens of joined line `line`, empty while it is not highlighted.
pub(crate) fn tokens(segments: &[Segment], line: usize) -> Vec<(Range<usize>, Token)> {
    let at = segments.partition_point(|s| s.first <= line);
    let Some(segment) = at.checked_sub(1).map(|i| &segments[i]) else {
        return Vec::new();
    };
    if line >= segment.first + segment.lines {
        return Vec::new();
    }
    segment
        .highlighter
        .as_ref()
        .and_then(|h| h.tokens(line - segment.first))
        .map(<[_]>::to_vec)
        .unwrap_or_default()
}

/// The parse (and a guess, for lines far past it) of each segment with
/// lines in `lines`, up to the last of them and on past it, by segment
/// index: the work [`finish`] takes back.
pub(crate) fn work(
    segments: &mut [Segment],
    lines: Range<usize>,
) -> Vec<(usize, Option<Guess>, Option<Job>)> {
    let mut work = Vec::new();
    for (index, segment) in segments.iter_mut().enumerate() {
        if !(segment.first < lines.end && lines.start < segment.first + segment.lines) {
            continue;
        }
        let Some(h) = &mut segment.highlighter else {
            continue;
        };
        let end = segment.lines.saturating_sub(1);
        let last = (lines.end - 1 - segment.first).min(end);
        let first = lines.start.saturating_sub(segment.first).min(last);
        let start = first.saturating_sub(GUESS_CONTEXT);
        let guess = (first > h.frontier().saturating_add(GUESS_DISTANCE))
            .then(|| h.guess(&segment.rope, start, segment.rope.line_to_byte(start), last))
            .flatten();
        let job = h.job(&segment.rope, (last + LOOKAHEAD).min(end), SLICE);
        if guess.is_some() || job.is_some() {
            work.push((index, guess, job));
        }
    }
    work
}

/// Gives segment `index` what its guess and its parse found: whether
/// tokens changed. Work for segments made since (other texts) is dropped.
pub(crate) fn finish(
    segments: &mut [Segment],
    index: usize,
    guessed: Option<Guessed>,
    done: Option<Done>,
) -> bool {
    let Some(h) = segments.get_mut(index).and_then(|s| s.highlighter.as_mut()) else {
        return false;
    };
    let mut changed = false;
    if let Some(guessed) = guessed {
        changed |= !h.guessed(guessed).is_empty();
    }
    if let Some(done) = done {
        changed |= !h.finish(done).0.is_empty();
    }
    changed
}

/// A file of the patch: its own texts and diff, and where it sits in the
/// joined ones.
pub(crate) struct FileSection {
    /// What the ref and the header are told (`collapsed` aside).
    file: DiffFile,
    model: DiffModel,
    old: String,
    new: String,
    /// Its hunks' headers, in its texts.
    headers: Vec<Header>,
    /// Its first line in the joined old text.
    old_at: usize,
    /// Its first line in the joined new text.
    new_at: usize,
    /// The index of its first hunk header among all the files'.
    header_at: usize,
}

/// A patch's files joined into two texts.
#[derive(Default)]
pub(crate) struct Joined {
    pub(crate) old: String,
    pub(crate) new: String,
    /// Each side's numbering (`Side::numbers`).
    pub(crate) numbers: super::controller::Numbers,
    /// The files' hunks, moved into the joined texts.
    pub(crate) model: DiffModel,
    /// Each side's segments.
    pub(crate) segments: (Vec<Segment>, Vec<Segment>),
    pub(crate) sections: Vec<FileSection>,
    /// The first file's path (the view's language when `language` is not
    /// set).
    pub(crate) path: Option<String>,
}

/// The files of `text`, a unified diff, joined; `language` (the prop) is
/// every file's language, else each file's path decides its own.
pub(crate) fn join(text: &str, language: Option<&str>) -> Joined {
    let files = match patch::parse_patch(text) {
        Ok(files) => files,
        Err(e) => {
            log::warn!("DiffView: the patch is not a unified diff: {e}");
            return Joined::default();
        }
    };
    let mut out = Joined::default();
    let mut hunks = Vec::new();
    let (mut old_at, mut new_at, mut header_at) = (0, 0, 0);
    for (index, file) in files.iter().enumerate() {
        let (old, new, firsts) = file.texts();
        let model = DiffModel::compute(&old, &new);
        let mut headers = Vec::with_capacity(file.hunks.len());
        let places = file.hunks.iter().zip(firsts).zip(file.text_starts());
        for ((hunk, (old_first, new_first)), (old_line, new_line)) in places {
            headers.push(Header {
                old: old_line,
                new: new_line,
                text: hunk.header.trim().to_string(),
            });
            // The files' lines count from 0 here, the numbers from 1.
            out.numbers.0.push((old_at + old_line, old_first + 1));
            out.numbers.1.push((new_at + new_line, new_first + 1));
        }
        let path = file.new_path.clone().or_else(|| file.old_path.clone());
        let name = language.map(str::to_string).or_else(|| path.clone());
        let (_, syntax) = languages::resolve(name.as_deref().unwrap_or(""));
        if !old.is_empty() {
            out.segments
                .0
                .push(Segment::new(old_at, &old, syntax.clone()));
        }
        if !new.is_empty() {
            out.segments.1.push(Segment::new(new_at, &new, syntax));
        }
        append(&mut out.old, &old);
        append(&mut out.new, &new);
        let first_hunk = hunks.len();
        hunks.extend(model.hunks.iter().map(|h| Hunk {
            old: h.old.start + old_at..h.old.end + old_at,
            new: h.new.start + new_at..h.new.end + new_at,
        }));
        let (added, deleted) = model.stats();
        let moved = file.renamed || file.copied;
        let section = FileSection {
            file: DiffFile {
                index: index as u32,
                path: path.clone().unwrap_or_default().into(),
                old_path: file
                    .old_path
                    .clone()
                    .filter(|_| moved)
                    .map(SharedString::from),
                status: status(file),
                binary: file.binary,
                added: added as u32,
                deleted: deleted as u32,
                hunks: model.hunks.len() as u32,
                first_hunk: first_hunk as u32,
                collapsed: false,
            },
            headers,
            old_at,
            new_at,
            header_at,
            model,
            old,
            new,
        };
        old_at += model::line_starts(&section.old).len();
        new_at += model::line_starts(&section.new).len();
        header_at += file.hunks.len();
        if out.path.is_none() {
            out.path = path;
        }
        out.sections.push(section);
    }
    out.model = DiffModel::joined(&out.old, &out.new, hunks);
    out
}

/// `text` after `joined`, ending with a line break so the next file's
/// first line is a line of its own.
fn append(joined: &mut String, text: &str) {
    joined.push_str(text);
    if !text.is_empty() && !text.ends_with('\n') {
        joined.push('\n');
    }
}

fn status(file: &FilePatch) -> DiffFileStatus {
    match (&file.old_path, &file.new_path) {
        (None, Some(_)) => DiffFileStatus::Added,
        (Some(_), None) => DiffFileStatus::Deleted,
        _ if file.renamed => DiffFileStatus::Renamed,
        _ if file.copied => DiffFileStatus::Copied,
        _ => DiffFileStatus::Modified,
    }
}

/// The files the view shows, and which of them are collapsed.
#[derive(Default)]
pub(crate) struct Files {
    sections: Vec<FileSection>,
    /// The paths of the collapsed files: they stay collapsed when a new
    /// patch still has them.
    collapsed: HashSet<String>,
}

impl Files {
    /// Shows `sections` (none for two texts).
    pub(crate) fn set(&mut self, sections: Vec<FileSection>) {
        self.collapsed
            .retain(|path| sections.iter().any(|f| f.file.path.as_str() == path));
        self.sections = sections;
    }

    /// Whether the texts are a patch's files.
    pub(crate) fn any(&self) -> bool {
        !self.sections.is_empty()
    }

    /// How many files there are.
    pub(crate) fn count(&self) -> usize {
        self.sections.len()
    }

    /// The rows: each file's (its header first when `headers`), unless it
    /// is collapsed, moved into the joined texts.
    pub(crate) fn rows(&self, layout: Layout, headers: bool) -> Vec<Row> {
        let mut rows = Vec::new();
        for (i, f) in self.sections.iter().enumerate() {
            if headers {
                rows.push(Row::File { file: i });
            }
            if self.collapsed.contains(f.file.path.as_str()) {
                continue;
            }
            let options = Options {
                layout,
                context: 0,
                expand_all: true,
                headers: f.headers.clone(),
            };
            let first_hunk = f.file.first_hunk as usize;
            let file_rows =
                layout::rows(&f.model, &f.old, &f.new, &options, &Expansions::default());
            rows.extend(file_rows.into_iter().map(|row| match row {
                Row::Line {
                    old,
                    new,
                    kind,
                    hunk,
                } => Row::Line {
                    old: old.map(|line| line + f.old_at),
                    new: new.map(|line| line + f.new_at),
                    kind,
                    hunk: hunk.map(|h| h + first_hunk),
                },
                Row::Separator {
                    gap,
                    lines,
                    first,
                    last,
                    header,
                } => Row::Separator {
                    gap: gap + f.header_at,
                    lines,
                    first,
                    last,
                    header,
                },
                other => other,
            }));
        }
        rows
    }

    /// File `index` as the ref and its header give it.
    pub(crate) fn file(&self, index: usize) -> Option<DiffFile> {
        let f = self.sections.get(index)?;
        Some(DiffFile {
            collapsed: self.collapsed.contains(f.file.path.as_str()),
            ..f.file.clone()
        })
    }

    /// Every file, in order.
    pub(crate) fn list(&self) -> Vec<DiffFile> {
        (0..self.sections.len())
            .filter_map(|i| self.file(i))
            .collect()
    }

    /// The index of the file at `path`.
    pub(crate) fn index(&self, path: &str) -> Option<usize> {
        self.sections
            .iter()
            .position(|f| f.file.path.as_str() == path)
    }

    /// Collapses (`Some(true)`), expands or toggles (`None`) the file at
    /// `path`: the file then, `None` when nothing changed.
    pub(crate) fn set_collapsed(
        &mut self,
        path: &str,
        collapsed: Option<bool>,
    ) -> Option<DiffFile> {
        let index = self.index(path)?;
        let now = self.collapsed.contains(path);
        let want = collapsed.unwrap_or(!now);
        if want == now {
            return None;
        }
        if want {
            self.collapsed.insert(path.to_string());
        } else {
            self.collapsed.remove(path);
        }
        self.file(index)
    }

    /// The path of the collapsed file hunk `index` belongs to.
    pub(crate) fn collapsed_file_of_hunk(&self, index: usize) -> Option<String> {
        let f = self.section_of_hunk(index as u32)?;
        let path = f.file.path.as_str();
        self.collapsed.contains(path).then(|| path.to_string())
    }

    fn section_of_hunk(&self, index: u32) -> Option<&FileSection> {
        self.sections
            .iter()
            .find(|f| (f.file.first_hunk..f.file.first_hunk + f.file.hunks).contains(&index))
    }

    /// Gives `hunks` (of the joined model) their files, and their lines in
    /// their files' texts.
    pub(crate) fn localize(&self, hunks: &mut [DiffHunk]) {
        for hunk in hunks {
            if let Some(f) = self.section_of_hunk(hunk.index) {
                hunk.file = f.file.index;
                hunk.old_start = hunk.old_start.saturating_sub(f.old_at as u32);
                hunk.new_start = hunk.new_start.saturating_sub(f.new_at as u32);
            }
        }
    }
}

/// The row of file `index`'s header.
pub(crate) fn file_row(rows: &[Row], index: usize) -> Option<usize> {
    rows.iter()
        .position(|row| matches!(row, Row::File { file } if *file == index))
}

/// The file headers in view, across the view.
pub(crate) fn headers(dv: Dv, rows: Memo<Vec<usize>>) -> impl IntoElement {
    let list = {
        let dv = dv.clone();
        computed(move || {
            dv.rev.get();
            let st = dv.st.borrow();
            rows.get()
                .into_iter()
                .filter_map(|row| match st.rows.get(row)? {
                    Row::File { file } => Some((row, st.files.file(*file)?)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
    };
    each(
        list,
        |(row, file): &(usize, DiffFile)| (*row, file.clone()),
        move |item, _| {
            let (row, file) = item.get_untracked();
            header(dv.clone(), row, file)
        },
    )
}

fn header(dv: Dv, row: usize, file: DiffFile) -> AnyElement {
    let props = dv.props;
    let lh = {
        let dv = dv.clone();
        move || {
            dv.rev.get();
            dv.st.borrow().font.line_height
        }
    };
    let lh2 = lh.clone();
    let place = view()
        .absolute()
        .left_0()
        .right_0()
        .top(move || Length::from(lh() * row as f32))
        .h(move || Length::from(lh2()));
    if let Some(render) = props.render_file_header.get_untracked() {
        return place
            .child(render.render(format!("file:{}", file.path), file).flex_1())
            .into_element();
    }
    let name = match &file.old_path {
        Some(old) => format!("{old} → {}", file.path),
        None => file.path.to_string(),
    };
    let path = file.path.to_string();
    part(
        place
            .flex_row()
            .items_center()
            .px(px(PAD))
            .bg(move || theme().secondary)
            .text_color(move || theme().secondary_foreground)
            .border_b_1()
            .border_color(move || theme().border)
            .child(
                text(if file.collapsed { "▸" } else { "▾" })
                    .text_color(move || theme().muted_foreground),
            )
            .child(
                text(name)
                    .number_of_lines(1)
                    .flex_1()
                    .ml(px(PAD))
                    .font_weight(FontWeight::MEDIUM),
            )
            .child(
                text(format!("+{}", file.added))
                    .ml(px(PAD))
                    .text_color(ADDED),
            )
            .child(
                text(format!("−{}", file.deleted))
                    .ml(px(PAD))
                    .text_color(DELETED),
            ),
        props,
        DiffViewPart::FileHeader,
    )
    .on_press(move || dv.set_file_collapsed(&path, None))
    .into_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::layout::Kind;

    const PATCH: &str = "\
diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -10,3 +10,3 @@ fn a
 one
-two
+TWO
 three
@@ -20,2 +20,3 @@ fn b
 x
+y
 z
diff --git a/b.txt b/c.txt
similarity index 90%
rename from b.txt
rename to c.txt
--- a/b.txt
+++ b/c.txt
@@ -1,2 +1,1 @@
-gone
 kept
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
";

    #[test]
    fn files_join_with_their_lines_and_hunks_in_order() {
        let joined = join(PATCH, None);
        assert_eq!(joined.sections.len(), 3);
        // a.rs: 5 old lines (3 + 2), 6 new; c.txt: 2 old, 1 new (its last
        // line given a line break in the joined text).
        assert_eq!(joined.old, "one\ntwo\nthree\nx\nz\ngone\nkept\n");
        assert_eq!(joined.new, "one\nTWO\nthree\nx\ny\nz\nkept\n");
        let [a, c, png] = &joined.sections[..] else {
            panic!("three files");
        };
        assert_eq!((a.old_at, a.new_at, a.header_at), (0, 0, 0));
        assert_eq!((c.old_at, c.new_at, c.header_at), (5, 6, 2));
        assert_eq!((png.old_at, png.new_at, png.header_at), (7, 7, 3));
        assert_eq!(
            (
                a.file.hunks,
                a.file.first_hunk,
                a.file.added,
                a.file.deleted
            ),
            (2, 0, 2, 1)
        );
        assert_eq!(c.file.status, DiffFileStatus::Renamed);
        assert_eq!(c.file.path.as_str(), "c.txt");
        assert_eq!(c.file.old_path.as_ref().map(|p| p.as_str()), Some("b.txt"));
        assert_eq!((c.file.first_hunk, c.file.deleted), (2, 1));
        assert!(png.file.binary && png.file.hunks == 0);
        assert_eq!(png.file.status, DiffFileStatus::Modified);
        // The joined model's hunks are the files', moved.
        let hunks: Vec<_> = joined
            .model
            .hunks
            .iter()
            .map(|h| (h.old.clone(), h.new.clone()))
            .collect();
        assert_eq!(hunks, vec![(1..2, 1..2), (4..4, 4..5), (5..6, 6..6)]);
        assert_eq!(joined.model.stats(), (2, 2));
        // Numbers restart at each file's hunks.
        assert_eq!(joined.numbers.0, vec![(0, 10), (3, 20), (5, 1)]);
        assert_eq!(joined.numbers.1, vec![(0, 10), (3, 20), (6, 1)]);
        assert_eq!(joined.path.as_deref(), Some("a.rs"));
    }

    #[test]
    fn rows_put_each_file_under_its_header_and_collapse() {
        let joined = join(PATCH, None);
        let mut files = Files::default();
        files.set(joined.sections);
        let rows = files.rows(Layout::Unified, true);
        assert_eq!(rows[0], Row::File { file: 0 });
        assert_eq!(file_row(&rows, 1), Some(10));
        assert_eq!(file_row(&rows, 2), Some(14));
        assert_eq!(rows.len(), 15);
        // c.txt's hunk header is the third of all; its deleted line is
        // joined old line 5, in hunk 2.
        assert_eq!(
            rows[11],
            Row::Separator {
                gap: 2,
                lines: 0,
                first: true,
                last: false,
                header: Some(String::new()),
            }
        );
        assert_eq!(
            rows[12],
            Row::Line {
                old: Some(5),
                new: None,
                kind: Kind::Deleted,
                hunk: Some(2),
            }
        );
        let a = files.set_collapsed("a.rs", None).unwrap();
        assert!(a.collapsed);
        assert_eq!(files.set_collapsed("a.rs", Some(true)), None);
        assert_eq!(files.collapsed_file_of_hunk(1).as_deref(), Some("a.rs"));
        assert_eq!(files.collapsed_file_of_hunk(2), None);
        let rows = files.rows(Layout::Unified, true);
        assert_eq!(&rows[..2], &[Row::File { file: 0 }, Row::File { file: 1 }]);
        assert_eq!(rows.len(), 6);
        // Without headers there is no header row.
        files.set_collapsed("a.rs", Some(false));
        assert!(
            !files
                .rows(Layout::Split, false)
                .contains(&Row::File { file: 0 })
        );
        assert_eq!(files.set_collapsed("missing", None), None);
    }

    #[test]
    fn collapsed_files_stay_collapsed_while_the_patch_has_them() {
        let mut files = Files::default();
        files.set(join(PATCH, None).sections);
        files.set_collapsed("c.txt", Some(true));
        files.set(join(PATCH, None).sections);
        assert!(files.list()[1].collapsed);
        let one = "--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-a\n+b\n";
        files.set(join(one, None).sections);
        files.set(join(PATCH, None).sections);
        assert!(!files.list()[1].collapsed);
    }

    #[test]
    fn hunks_are_given_back_in_their_files() {
        let joined = join(PATCH, None);
        let mut files = Files::default();
        files.set(joined.sections);
        let mut hunks: Vec<DiffHunk> = joined
            .model
            .hunks
            .iter()
            .enumerate()
            .map(|(index, h)| DiffHunk {
                index: index as u32,
                old_start: h.old.start as u32,
                old_lines: h.old.len() as u32,
                new_start: h.new.start as u32,
                new_lines: h.new.len() as u32,
                ..Default::default()
            })
            .collect();
        files.localize(&mut hunks);
        let got: Vec<_> = hunks
            .iter()
            .map(|h| (h.index, h.file, h.old_start, h.new_start))
            .collect();
        assert_eq!(got, vec![(0, 0, 1, 1), (1, 0, 4, 4), (2, 1, 0, 0)]);
    }

    #[test]
    fn segments_find_their_lines() {
        let segments = vec![
            Segment::new(0, "a\nb\n", Syntax::builtin("rs")),
            Segment::new(5, "c\n", Syntax::Plain),
        ];
        assert!(hinted(&segments));
        // Not highlighted yet: no tokens, and none past a segment's lines.
        assert!(tokens(&segments, 1).is_empty());
        assert!(tokens(&segments, 3).is_empty());
        assert!(tokens(&segments, 9).is_empty());
        assert!(!hinted(&segments[1..]));
    }

    #[test]
    fn a_bad_patch_has_no_files() {
        let joined = join("@@ -1,2 +1,2 @@\n-a\n", None);
        assert!(joined.sections.is_empty() && joined.old.is_empty());
    }
}
