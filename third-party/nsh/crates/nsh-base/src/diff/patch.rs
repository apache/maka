//! Unified diffs (`git diff`, `git format-patch`, `diff -u`): reading their
//! files and hunks, the texts a diff view shows of them, and applying them.
//!
//! Patch lines are split at `\n` alone: the lines of a file with `\r\n`
//! line breaks keep their `\r` as content (what applying them needs), and
//! only the header lines lose it.

/// One file of a unified diff (`git diff`, `diff -u`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct FilePatch {
    /// The file's path before (without git's `a/`); `None` for a file added (`/dev/null`).
    pub(crate) old_path: Option<String>,
    /// The file's path after (without git's `b/`); `None` for a file deleted (`/dev/null`).
    pub(crate) new_path: Option<String>,
    /// The changes, in order.
    pub(crate) hunks: Vec<PatchHunk>,
    /// A change of a binary file, whose lines git does not show (`Binary files … differ`, `GIT binary patch`).
    pub(crate) binary: bool,
    /// The file's mode before (`old mode`, `deleted file mode`), as git prints it ("100644").
    pub(crate) old_mode: Option<String>,
    /// The file's mode after (`new mode`, `new file mode`).
    pub(crate) new_mode: Option<String>,
    /// Git saw the file renamed (`rename from` / `rename to`).
    pub(crate) renamed: bool,
    /// Git saw the file copied (`copy from` / `copy to`).
    pub(crate) copied: bool,
    /// How alike the old and new files are, in percent, for a rename or copy (`similarity index`).
    pub(crate) similarity: Option<u32>,
}

/// One hunk of a [`FilePatch`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct PatchHunk {
    /// The first old line, from 1, as in the header (the line before the hunk when `old_count` is 0).
    pub(crate) old_start: usize,
    /// How many old lines the hunk shows.
    pub(crate) old_count: usize,
    /// The first new line, from 1, as in the header (the line before the hunk when `new_count` is 0).
    pub(crate) new_start: usize,
    /// How many new lines the hunk shows.
    pub(crate) new_count: usize,
    /// The text after the second `@@` (the function the hunk is in), without the space before it.
    pub(crate) header: String,
    /// The lines, in order.
    pub(crate) lines: Vec<PatchLine>,
}

/// A line of a [`PatchHunk`], without its first character and its `\n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PatchLine {
    /// A line of both files (` `).
    Context(String),
    /// A line of the new file only (`+`).
    Added(String),
    /// A line of the old file only (`-`).
    Deleted(String),
    /// `\ No newline at end of file`: the line before it ends its file(s) without a line break.
    NoNewline,
}

/// Reads the files a unified diff changes, in order: those of `git diff` and `git format-patch` (renames, copies,
/// modes, new, deleted and binary files; text before the first file, as a commit message, is skipped) and those of
/// `diff -u`. Errors name the patch's line (from 1).
pub(crate) fn parse_patch(text: &str) -> Result<Vec<FilePatch>, String> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    let mut files: Vec<FilePatch> = Vec::new();
    // Whether the current file has a `diff --git` header: its names have
    // git's `a/` and `b/` prefixes.
    let mut git = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].strip_suffix('\r').unwrap_or(lines[i]);
        if let Some(names) = line.strip_prefix("diff --git ") {
            git = true;
            let mut file = FilePatch::default();
            if let Some((old, new)) = git_names(names) {
                (file.old_path, file.new_path) = (Some(old), Some(new));
            }
            files.push(file);
        } else if git
            && let Some(file) = files.last_mut()
            && file.hunks.is_empty()
            && extended_header(file, line)
        {
            // Read into the file: modes, renames, copies, binary.
        } else if line.starts_with("--- ")
            && lines
                .get(i + 1)
                .is_some_and(|next| next.starts_with("+++ "))
        {
            // A `diff -u` file starts here, or a git file's names follow
            // its extended header.
            if files
                .last()
                .is_none_or(|file| !file.hunks.is_empty() || !git)
            {
                git = false;
                files.push(FilePatch::default());
            }
            let next = lines[i + 1].strip_suffix('\r').unwrap_or(lines[i + 1]);
            let file = files.last_mut().expect("a file was just pushed");
            file.old_path = patch_name(&line[4..], git.then_some("a/"));
            file.new_path = patch_name(&next[4..], git.then_some("b/"));
            i += 1;
        } else if line.starts_with("@@ ") {
            if files.is_empty() {
                files.push(FilePatch::default());
            }
            let header_line = i + 1;
            let mut hunk = hunk_header(line).map_err(|error| format!("line {}: {error}", i + 1))?;
            let (mut old_left, mut new_left) = (hunk.old_count, hunk.new_count);
            while let Some(&next) = lines.get(i + 1) {
                if old_left == 0 && new_left == 0 && !next.starts_with('\\') {
                    break;
                }
                let content = || next.get(1..).unwrap_or("").to_string();
                let parsed = match next.as_bytes().first() {
                    Some(b'\\') => PatchLine::NoNewline,
                    Some(b'+') => PatchLine::Added(content()),
                    Some(b'-') => PatchLine::Deleted(content()),
                    Some(b' ') => PatchLine::Context(content()),
                    // A blank line of both files, whose space a tool
                    // stripped.
                    None => PatchLine::Context(String::new()),
                    Some(b'\r') if next == "\r" => PatchLine::Context(next.to_string()),
                    _ => return Err(format!("line {}: unexpected {next:?} in a hunk", i + 2)),
                };
                let (old, new) = match parsed {
                    PatchLine::Context(_) => (1, 1),
                    PatchLine::Deleted(_) => (1, 0),
                    PatchLine::Added(_) => (0, 1),
                    PatchLine::NoNewline => (0, 0),
                };
                if old > old_left || new > new_left {
                    return Err(format!(
                        "line {}: the hunk at line {header_line} has more lines than its header counts",
                        i + 2
                    ));
                }
                (old_left, new_left) = (old_left - old, new_left - new);
                hunk.lines.push(parsed);
                i += 1;
            }
            if old_left > 0 || new_left > 0 {
                return Err(format!("line {}: the hunk {line:?} ends early", i + 1));
            }
            files.last_mut().expect("a file exists").hunks.push(hunk);
        }
        i += 1;
    }
    Ok(files)
}

impl FilePatch {
    /// The old and new texts the hunks show (only the hunks' lines, in order: what a pull request's diff gives
    /// without the files), and for each hunk the line its lines start at in the files, from 0 (to number the lines
    /// as in the files): `(old_text, new_text, Vec<(old_first_line_in_file, new_first_line_in_file)>)`. A line
    /// followed by "\ No newline at end of file" has no line break in the texts. [`FilePatch::text_starts`] gives
    /// where each hunk starts in the texts.
    pub(crate) fn texts(&self) -> (String, String, Vec<(usize, usize)>) {
        let (mut old, mut new) = (String::new(), String::new());
        let push = |text: &mut String, line: &str, newline: bool| {
            text.push_str(line);
            if newline {
                text.push('\n');
            }
        };
        for hunk in &self.hunks {
            let mut lines = hunk.lines.iter().peekable();
            while let Some(line) = lines.next() {
                let newline = !matches!(lines.peek(), Some(PatchLine::NoNewline));
                match line {
                    PatchLine::Context(line) => {
                        push(&mut old, line, newline);
                        push(&mut new, line, newline);
                    }
                    PatchLine::Deleted(line) => push(&mut old, line, newline),
                    PatchLine::Added(line) => push(&mut new, line, newline),
                    PatchLine::NoNewline => {}
                }
            }
        }
        let starts = self
            .hunks
            .iter()
            .map(|hunk| {
                (
                    file_line(hunk.old_start, hunk.old_count),
                    file_line(hunk.new_start, hunk.new_count),
                )
            })
            .collect();
        (old, new, starts)
    }

    /// For each hunk, the line (from 0) its lines start at in the old and the new text of [`FilePatch::texts`].
    pub(crate) fn text_starts(&self) -> Vec<(usize, usize)> {
        let (mut old, mut new) = (0, 0);
        self.hunks
            .iter()
            .map(|hunk| {
                let start = (old, new);
                for line in &hunk.lines {
                    match line {
                        PatchLine::Context(_) => (old, new) = (old + 1, new + 1),
                        PatchLine::Deleted(_) => old += 1,
                        PatchLine::Added(_) => new += 1,
                        PatchLine::NoNewline => {}
                    }
                }
                start
            })
            .collect()
    }

    /// Applies the patch to the old file's text: the new file's text. The lines the hunks show of the old file
    /// (context and deleted) must be where the headers say. The new text ends with a line break as the old one
    /// does, unless a hunk reaching the end of the file says otherwise ("\ No newline at end of file").
    #[cfg(test)]
    pub(crate) fn apply(&self, old: &str) -> Result<String, String> {
        if self.binary {
            return Err("a binary patch has no lines to apply".to_string());
        }
        let mut lines: Vec<&str> = if old.is_empty() {
            Vec::new()
        } else {
            old.split('\n').collect()
        };
        let old_newline = old.ends_with('\n');
        if old_newline {
            lines.pop();
        }
        let mut out: Vec<&str> = Vec::with_capacity(lines.len());
        let mut at = 0;
        let mut new_newline = old_newline || old.is_empty();
        for hunk in &self.hunks {
            let start = file_line(hunk.old_start, hunk.old_count);
            if start < at || start > lines.len() {
                return Err(format!(
                    "the hunk at old line {} is out of place",
                    hunk.old_start
                ));
            }
            out.extend_from_slice(&lines[at..start]);
            at = start;
            // Whether the last new line of the hunk so far ends the file
            // without a line break; None: the hunk has no new line yet.
            let mut last_new: Option<bool> = None;
            let mut previous_new = false;
            for line in &hunk.lines {
                match line {
                    PatchLine::Context(text) | PatchLine::Deleted(text) => {
                        if lines.get(at) != Some(&text.as_str()) {
                            return Err(format!(
                                "the hunk at old line {} does not match old line {}",
                                hunk.old_start,
                                at + 1
                            ));
                        }
                        at += 1;
                        previous_new = matches!(line, PatchLine::Context(_));
                        if previous_new {
                            out.push(text);
                            last_new = Some(false);
                        }
                    }
                    PatchLine::Added(text) => {
                        out.push(text);
                        last_new = Some(false);
                        previous_new = true;
                    }
                    PatchLine::NoNewline => {
                        if previous_new {
                            last_new = Some(true);
                        }
                    }
                }
            }
            if at == lines.len() {
                // The hunk reaches the end of the old file: it says how the
                // new one ends, or its new lines end where an earlier line
                // did, which has its line break.
                new_newline = !last_new.unwrap_or(false);
            }
        }
        out.extend_from_slice(&lines[at..]);
        let mut text = out.join("\n");
        if new_newline && !out.is_empty() {
            text.push('\n');
        }
        Ok(text)
    }
}

/// A hunk's first line in its file, from 0, from its header's start (from 1, or the line before an empty side).
fn file_line(start: usize, count: usize) -> usize {
    if count == 0 {
        start
    } else {
        start.saturating_sub(1)
    }
}

/// Reads one of git's extended header lines into `file`; false when `line` is not one.
fn extended_header(file: &mut FilePatch, line: &str) -> bool {
    let rest = |prefix: &str| line.strip_prefix(prefix);
    if let Some(mode) = rest("new file mode ") {
        file.old_path = None;
        file.new_mode = Some(mode.to_string());
    } else if let Some(mode) = rest("deleted file mode ") {
        file.new_path = None;
        file.old_mode = Some(mode.to_string());
    } else if let Some(mode) = rest("old mode ") {
        file.old_mode = Some(mode.to_string());
    } else if let Some(mode) = rest("new mode ") {
        file.new_mode = Some(mode.to_string());
    } else if let Some(name) = rest("rename from ") {
        file.renamed = true;
        file.old_path = Some(unquote_name(name));
    } else if let Some(name) = rest("rename to ") {
        file.renamed = true;
        file.new_path = Some(unquote_name(name));
    } else if let Some(name) = rest("copy from ") {
        file.copied = true;
        file.old_path = Some(unquote_name(name));
    } else if let Some(name) = rest("copy to ") {
        file.copied = true;
        file.new_path = Some(unquote_name(name));
    } else if let Some(index) = rest("similarity index ") {
        file.similarity = index.trim_end_matches('%').parse().ok();
    } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
        file.binary = true;
    } else {
        return false;
    }
    true
}

/// The names of `diff --git a/x b/x`, without their prefixes.
fn git_names(names: &str) -> Option<(String, String)> {
    let strip = |name: String, prefix: &str| {
        name.strip_prefix(prefix)
            .map(str::to_string)
            .unwrap_or(name)
    };
    // Git quotes names, as C strings, when they hold quotes, control
    // characters or (by default) bytes past ASCII.
    if names.starts_with('"') {
        let (old, rest) = unquote(names)?;
        let rest = rest.strip_prefix(' ')?;
        let new = if rest.starts_with('"') {
            unquote(rest)?.0
        } else {
            rest.to_string()
        };
        return Some((strip(old, "a/"), strip(new, "b/")));
    }
    if let Some(at) = names.find(" \"b/") {
        let new = unquote(&names[at + 1..])?.0;
        return Some((strip(names[..at].to_string(), "a/"), strip(new, "b/")));
    }
    // Unless renamed (which `rename` lines then say), the two names are
    // equal but for their prefixes, which finds the space between them
    // even when the names hold spaces.
    let half = names.len() / 2;
    if names.len() % 2 == 1
        && names.as_bytes()[half] == b' '
        && let (Some(old), Some(new)) = (names.get(..half), names.get(half + 1..))
        && old.strip_prefix("a/").unwrap_or(old) == new.strip_prefix("b/").unwrap_or(new)
    {
        return Some((strip(old.to_string(), "a/"), strip(new.to_string(), "b/")));
    }
    let at = names.find(" b/")?;
    Some((
        strip(names[..at].to_string(), "a/"),
        names[at + 3..].to_string(),
    ))
}

/// The name of a `---` or `+++` line: `None` for `/dev/null`; a tab ends it (`diff -u` puts the time after one).
fn patch_name(name: &str, prefix: Option<&str>) -> Option<String> {
    let name = name.split('\t').next().unwrap_or(name).trim_end();
    if name == "/dev/null" {
        return None;
    }
    let name = unquote_name(name);
    Some(match prefix {
        Some(prefix) => name
            .strip_prefix(prefix)
            .map(str::to_string)
            .unwrap_or(name),
        None => name,
    })
}

/// A name git may have quoted: unquoted, or as it is.
fn unquote_name(name: &str) -> String {
    match unquote(name) {
        Some((unquoted, "")) => unquoted,
        _ => name.to_string(),
    }
}

/// The C-style quoted string `text` starts with (git's quoting: `\"`, `\\`, `\t`, `\n`, octal bytes such as
/// `\346\226\207`), and the rest after its closing quote.
fn unquote(text: &str) -> Option<(String, &str)> {
    let body = text.strip_prefix('"')?;
    let bytes = body.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some((String::from_utf8_lossy(&out).into_owned(), &body[i + 1..])),
            b'\\' => {
                let escape = *bytes.get(i + 1)?;
                i += 2;
                out.push(match escape {
                    b'a' => 0x07,
                    b'b' => 0x08,
                    b'f' => 0x0C,
                    b'n' => b'\n',
                    b'r' => b'\r',
                    b't' => b'\t',
                    b'v' => 0x0B,
                    b'0'..=b'7' => {
                        let mut value = u32::from(escape - b'0');
                        for _ in 0..2 {
                            match bytes.get(i) {
                                Some(&digit @ b'0'..=b'7') => {
                                    value = value * 8 + u32::from(digit - b'0');
                                    i += 1;
                                }
                                _ => break,
                            }
                        }
                        u8::try_from(value).ok()?
                    }
                    other => other,
                });
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    None
}

/// Reads `@@ -a,b +c,d @@ header`.
fn hunk_header(line: &str) -> Result<PatchHunk, String> {
    let malformed = || format!("malformed hunk header {line:?}");
    let body = line.strip_prefix("@@ ").ok_or_else(malformed)?;
    let end = body.find(" @@").ok_or_else(malformed)?;
    let mut ranges = body[..end].split_whitespace();
    let (Some(old), Some(new), None) = (ranges.next(), ranges.next(), ranges.next()) else {
        return Err(malformed());
    };
    let range = |text: Option<&str>| -> Result<(usize, usize), String> {
        let text = text.ok_or_else(malformed)?;
        let (start, count) = text.split_once(',').unwrap_or((text, "1"));
        Ok((
            start.parse().map_err(|_| malformed())?,
            count.parse().map_err(|_| malformed())?,
        ))
    };
    let (old_start, old_count) = range(old.strip_prefix('-'))?;
    let (new_start, new_count) = range(new.strip_prefix('+'))?;
    let header = &body[end + 3..];
    Ok(PatchHunk {
        old_start,
        old_count,
        new_start,
        new_count,
        header: header.strip_prefix(' ').unwrap_or(header).to_string(),
        lines: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(line: &str) -> PatchLine {
        PatchLine::Context(line.to_string())
    }
    fn added(line: &str) -> PatchLine {
        PatchLine::Added(line.to_string())
    }
    fn deleted(line: &str) -> PatchLine {
        PatchLine::Deleted(line.to_string())
    }
    fn one(patch: &str) -> FilePatch {
        let mut files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 1, "{files:?}");
        files.remove(0)
    }

    const MODIFIED: &str = "\
diff --git a/src/lib.rs b/src/lib.rs
index 3b18e51..a8c2f3d 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,4 +1,5 @@ fn main() {
 fn main() {
-    let x = 1;
+    let x = 2;
+    let y = 3;
     println!(\"{x}\");
 }
@@ -10,2 +11,2 @@ fn other() {
 a
-b
+B
";

    const MODIFIED_OLD: &str =
        "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n5\n6\n7\n8\n9\na\nb\n";

    #[test]
    fn a_modified_file() {
        let file = one(MODIFIED);
        assert_eq!(file.old_path.as_deref(), Some("src/lib.rs"));
        assert_eq!(file.new_path.as_deref(), Some("src/lib.rs"));
        assert!(!file.binary && !file.renamed);
        assert_eq!(file.hunks.len(), 2);
        let hunk = &file.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_count,
                hunk.new_start,
                hunk.new_count
            ),
            (1, 4, 1, 5)
        );
        assert_eq!(hunk.header, "fn main() {");
        assert_eq!(
            hunk.lines,
            vec![
                context("fn main() {"),
                deleted("    let x = 1;"),
                added("    let x = 2;"),
                added("    let y = 3;"),
                context("    println!(\"{x}\");"),
                context("}"),
            ]
        );
        let (old, new, starts) = file.texts();
        assert_eq!(
            old,
            "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\na\nb\n"
        );
        assert_eq!(
            new,
            "fn main() {\n    let x = 2;\n    let y = 3;\n    println!(\"{x}\");\n}\na\nB\n"
        );
        assert_eq!(starts, vec![(0, 0), (9, 10)]);
        assert_eq!(file.text_starts(), vec![(0, 0), (4, 5)]);
        assert_eq!(
            file.apply(MODIFIED_OLD).unwrap(),
            "fn main() {\n    let x = 2;\n    let y = 3;\n    println!(\"{x}\");\n}\n5\n6\n7\n8\n9\na\nB\n"
        );
    }

    #[test]
    fn texts_diff_as_the_hunks_show() {
        let (old, new, _) = one(MODIFIED).texts();
        let model = crate::diff::model::DiffModel::compute(&old, &new);
        assert_eq!(model.stats(), (3, 2));
    }

    #[test]
    fn new_and_deleted_files() {
        let patch = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.txt b/gone.txt
deleted file mode 100755
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
";
        let files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(
            (files[0].old_path.as_deref(), files[0].new_path.as_deref()),
            (None, Some("new.txt"))
        );
        assert_eq!(files[0].new_mode.as_deref(), Some("100644"));
        assert_eq!(files[0].apply("").unwrap(), "one\ntwo\n");
        assert_eq!(files[0].texts().2, vec![(0, 0)]);
        assert_eq!(
            (files[1].old_path.as_deref(), files[1].new_path.as_deref()),
            (Some("gone.txt"), None)
        );
        assert_eq!(files[1].old_mode.as_deref(), Some("100755"));
        assert_eq!(files[1].hunks[0].old_count, 1);
        assert_eq!(files[1].apply("bye\n").unwrap(), "");
        let (old, new, starts) = files[1].texts();
        assert_eq!((old.as_str(), new.as_str()), ("bye\n", ""));
        assert_eq!(starts, vec![(0, 0)]);
    }

    #[test]
    fn an_empty_new_file_and_a_mode_change() {
        let patch = "\
diff --git a/empty b/empty
new file mode 100644
index 0000000..e69de29
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
";
        let files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(
            (files[0].old_path.as_deref(), files[0].new_path.as_deref()),
            (None, Some("empty"))
        );
        assert!(files[0].hunks.is_empty());
        assert_eq!(files[0].apply("").unwrap(), "");
        assert_eq!(files[1].old_path.as_deref(), Some("run.sh"));
        assert_eq!(
            (files[1].old_mode.as_deref(), files[1].new_mode.as_deref()),
            (Some("100644"), Some("100755"))
        );
        assert_eq!(files[1].apply("echo\n").unwrap(), "echo\n");
    }

    #[test]
    fn renames_and_copies() {
        let patch = "\
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 1111111..2222222 100644
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-hello
+hello!
diff --git a/a.txt b/c.txt
similarity index 100%
copy from a.txt
copy to c.txt
";
        let files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].renamed);
        assert_eq!(files[0].similarity, Some(90));
        assert_eq!(files[0].old_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[0].new_path.as_deref(), Some("new name.txt"));
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].apply("hello\n").unwrap(), "hello!\n");
        assert!(files[1].copied && files[1].hunks.is_empty());
        assert_eq!(
            (files[1].old_path.as_deref(), files[1].new_path.as_deref()),
            (Some("a.txt"), Some("c.txt"))
        );
        assert_eq!(files[1].similarity, Some(100));
    }

    #[test]
    fn binary_files() {
        let patch = "\
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/x.bin b/x.bin
new file mode 100644
index 0000000..1234567
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

literal 0
HcmV?d00001

";
        let files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].binary && files[1].binary);
        assert!(files[0].hunks.is_empty() && files[1].hunks.is_empty());
        assert_eq!(files[0].old_path.as_deref(), Some("logo.png"));
        assert!(files[0].apply("").is_err());
        assert_eq!(files[0].texts(), (String::new(), String::new(), vec![]));
    }

    #[test]
    fn quoted_names() {
        let patch = "\
diff --git \"a/\\346\\226\\207 \\\"q\\\".txt\" \"b/\\346\\226\\207 \\\"q\\\".txt\"
index 1111111..2222222 100644
--- \"a/\\346\\226\\207 \\\"q\\\".txt\"
+++ \"b/\\346\\226\\207 \\\"q\\\".txt\"
@@ -1 +1 @@
-a
+b
";
        let file = one(patch);
        assert_eq!(file.old_path.as_deref(), Some("文 \"q\".txt"));
        assert_eq!(file.new_path.as_deref(), Some("文 \"q\".txt"));
        assert_eq!(
            git_names("a/x \"b/y\\tz\""),
            Some(("x".to_string(), "y\tz".to_string()))
        );
        assert_eq!(
            git_names("a/x b/y"),
            Some(("x".to_string(), "y".to_string()))
        );
        assert_eq!(
            git_names("a/a b c b/a b c"),
            Some(("a b c".to_string(), "a b c".to_string()))
        );
    }

    #[test]
    fn no_newline_at_end_of_file() {
        // The old file lacks the final line break, the new one has it.
        let patch = "\
--- a.txt
+++ b.txt
@@ -1,2 +1,2 @@
 a
-b
\\ No newline at end of file
+b
";
        let file = one(patch);
        assert_eq!(
            file.hunks[0].lines,
            vec![context("a"), deleted("b"), PatchLine::NoNewline, added("b")]
        );
        assert_eq!(file.apply("a\nb").unwrap(), "a\nb\n");
        let (old, new, _) = file.texts();
        assert_eq!((old.as_str(), new.as_str()), ("a\nb", "a\nb\n"));

        // The new one loses it.
        let patch = "\
--- a.txt
+++ b.txt
@@ -1,2 +1,2 @@
 a
-b
+b
\\ No newline at end of file
";
        let file = one(patch);
        assert_eq!(file.apply("a\nb\n").unwrap(), "a\nb");
        let (old, new, _) = file.texts();
        assert_eq!((old.as_str(), new.as_str()), ("a\nb\n", "a\nb"));

        // Neither has it: the last line of both.
        let patch = "\
--- a.txt
+++ b.txt
@@ -1,2 +1,2 @@
-x
+y
 end
\\ No newline at end of file
";
        let file = one(patch);
        assert_eq!(file.apply("x\nend").unwrap(), "y\nend");
        let (old, new, _) = file.texts();
        assert_eq!((old.as_str(), new.as_str()), ("x\nend", "y\nend"));

        // Lines deleted from the end of a file without a final line break.
        let patch = "\
--- a.txt
+++ b.txt
@@ -2 +1,0 @@
-b
\\ No newline at end of file
";
        assert_eq!(one(patch).apply("a\nb").unwrap(), "a\n");
    }

    #[test]
    fn plain_unified_diffs() {
        let patch = "\
--- old/notes.txt\t2024-01-02 10:00:00.000000000 +0800
+++ new/notes.txt\t2024-01-02 10:05:00.000000000 +0800
@@ -1,3 +1,3 @@
 one
-two
+deux
 three
--- other.txt
+++ other.txt
@@ -1 +1 @@
-x
+y
";
        let files = parse_patch(patch).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].old_path.as_deref(), Some("old/notes.txt"));
        assert_eq!(files[0].new_path.as_deref(), Some("new/notes.txt"));
        assert_eq!(
            files[0].apply("one\ntwo\nthree\n").unwrap(),
            "one\ndeux\nthree\n"
        );
        assert_eq!(files[1].apply("x\n").unwrap(), "y\n");
    }

    #[test]
    fn format_patch_preamble_and_odd_lines() {
        let patch = "\
From 1234 Mon Sep 17 00:00:00 2001
From: Someone <someone@example.com>
Subject: [PATCH] Change things

---
 f | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,4 +1,4 @@
 --- not a header
--- deleted dashes
+++ added pluses

 last
--
2.40.0
";
        let file = one(patch);
        assert_eq!(
            file.hunks[0].lines,
            vec![
                context("--- not a header"),
                deleted("-- deleted dashes"),
                added("++ added pluses"),
                context(""),
                context("last")
            ]
        );
        assert_eq!(
            file.apply("--- not a header\n-- deleted dashes\n\nlast\n")
                .unwrap(),
            "--- not a header\n++ added pluses\n\nlast\n"
        );
    }

    #[test]
    fn a_blank_context_line_without_its_space() {
        let patch = "--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n\n-y\n+z\n";
        let file = one(patch);
        assert_eq!(
            file.hunks[0].lines,
            vec![context("x"), context(""), deleted("y"), added("z")]
        );
        assert_eq!(file.apply("x\n\ny\n").unwrap(), "x\n\nz\n");
    }

    #[test]
    fn crlf_lines_keep_their_cr() {
        let patch = "diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,2 +1,2 @@\r\n one\r\n-two\r\n+TWO\r\n";
        let file = one(patch);
        assert_eq!(file.new_path.as_deref(), Some("w.txt"));
        assert_eq!(
            file.hunks[0].lines,
            vec![context("one\r"), deleted("two\r"), added("TWO\r")]
        );
        assert_eq!(file.apply("one\r\ntwo\r\n").unwrap(), "one\r\nTWO\r\n");
        let (old, new, _) = file.texts();
        assert_eq!(
            (old.as_str(), new.as_str()),
            ("one\r\ntwo\r\n", "one\r\nTWO\r\n")
        );
    }

    #[test]
    fn hunk_headers() {
        let hunk = hunk_header("@@ -3 +4,0 @@").unwrap();
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_count,
                hunk.new_start,
                hunk.new_count
            ),
            (3, 1, 4, 0)
        );
        assert_eq!(hunk.header, "");
        let hunk = hunk_header("@@ -1,2 +1,3 @@ impl Foo {").unwrap();
        assert_eq!(hunk.header, "impl Foo {");
        assert!(hunk_header("@@ -1,2 @@").is_err());
        assert!(hunk_header("@@ -a +1 @@").is_err());
        assert!(hunk_header("@@ -1 +1").is_err());
        assert!(
            parse_patch("--- a\n+++ b\n@@ -x +1 @@\n")
                .unwrap_err()
                .starts_with("line 3:")
        );
    }

    #[test]
    fn malformed_hunks() {
        let early = parse_patch("--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n").unwrap_err();
        assert!(early.contains("ends early"), "{early}");
        let unexpected = parse_patch("--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n?b\n").unwrap_err();
        assert!(unexpected.starts_with("line 5:"), "{unexpected}");
        let more = parse_patch("--- a\n+++ b\n@@ -1 +1 @@\n-a\n-b\n+c\n").unwrap_err();
        assert!(more.starts_with("line 5:"), "{more}");
        assert_eq!(parse_patch("").unwrap(), vec![]);
        assert_eq!(parse_patch("just some text\n").unwrap(), vec![]);
    }

    #[test]
    fn apply_checks_the_old_lines() {
        let file = one(MODIFIED);
        let error = file.apply("fn main() {\n    let x = 5;\n").unwrap_err();
        assert!(error.contains("old line 2"), "{error}");
        let file = one("--- a\n+++ b\n@@ -5 +5 @@\n-x\n+y\n");
        assert!(file.apply("a\n").unwrap_err().contains("out of place"));
        let file = one("--- a\n+++ b\n@@ -1 +1 @@\n-é日本\n+🎉\n");
        assert_eq!(file.apply("é日本\nrest").unwrap(), "🎉\nrest");
    }

    #[test]
    fn apply_appends_and_keeps_the_end() {
        // Adding after a last line without a line break changes that line.
        let file = one("--- a\n+++ b\n@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b\n");
        assert_eq!(file.apply("a").unwrap(), "a\nb\n");
        // A hunk away from the end keeps how the file ends.
        let file = one("--- a\n+++ b\n@@ -1 +1 @@\n-a\n+A\n");
        assert_eq!(file.apply("a\nb").unwrap(), "A\nb");
        assert_eq!(file.apply("a\nb\n").unwrap(), "A\nb\n");
    }
}
