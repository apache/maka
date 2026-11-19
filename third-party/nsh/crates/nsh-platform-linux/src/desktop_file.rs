//! Reading and writing desktop entries (the Desktop Entry specification's
//! `.desktop` files): the app's login item ([`crate::login_item`]) and the
//! entry that opens its links and files ([`crate::links`]).

use std::{io, path::Path};

/// The text of the file at `path`, `None` when there is none. An entry
/// that is not UTF-8 (another program's) reads with its bytes replaced, so
/// NSH can still write its own over it.
pub(crate) fn read(path: &Path) -> io::Result<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes `text` to `path` in `dir` whole: a reader sees the old entry or
/// the new one, never a part.
pub(crate) fn write_atomically(dir: &Path, path: &Path, text: &str) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, text)
        .and_then(|()| std::fs::rename(&temporary, path))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&temporary);
        })
}

/// The program of an `Exec` value (its string escapes undone): its first
/// argument, quoted with `"`, `` ` ``, `$` and `\` escaped inside the quotes,
/// or up to the first space, `%%` a `%`. The inverse of [`exec_arg`]. An
/// argument the specification does not allow, which shells and GLib would
/// read as a longer one (`"/a"-b`, `/a"b"`), is no program.
pub(crate) fn program(exec: &str) -> Option<String> {
    let exec = exec.trim_start();
    let mut out = String::new();
    let mut chars = exec.chars();
    if exec.starts_with('"') {
        chars.next();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => out.push(chars.next()?),
                c => out.push(c),
            }
        }
        // The quotes hold the whole argument.
        if chars.next().is_some_and(|c| c != ' ' && c != '\t') {
            return None;
        }
    } else {
        out.extend(chars.take_while(|c| *c != ' ' && *c != '\t'));
        if out.contains(['"', '\'', '\\']) {
            return None;
        }
    }
    Some(out.replace("%%", "%")).filter(|program| !program.is_empty())
}

/// Value `key` of the entry's `[Desktop Entry]` group, its escapes undone:
/// its last, as GLib reads a key given twice.
pub(crate) fn value(text: &str, key: &str) -> Option<String> {
    // GLib trims ASCII white space only: a value's other spaces are its own.
    let blank = |c: char| c.is_ascii_whitespace();
    let mut group = "";
    let mut found = None;
    for line in text.lines() {
        let line = line.trim_matches(blank);
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            group = name;
        } else if group == "Desktop Entry"
            && let Some((k, v)) = line.split_once('=')
            && k.trim_end_matches(blank) == key
        {
            found = Some(v.trim_start_matches(blank));
        }
    }
    found.map(unescape)
}

/// A string value as the Desktop Entry specification writes it: a
/// backslash escaped, a line break as `\n` or `\r` (it would end the
/// line), and a space or tab at either end, which readers trim, as `\s` or
/// `\t`.
pub(crate) fn escape(value: &str) -> String {
    let start = value.len() - value.trim_start_matches([' ', '\t']).len();
    let end = value.trim_end_matches([' ', '\t']).len().max(start);
    let mut out = String::with_capacity(value.len());
    for (i, c) in value.char_indices() {
        let edge = i < start || i >= end;
        match c {
            '\\' => out.push_str("\\\\"),
            ' ' if edge => out.push_str("\\s"),
            '\t' if edge => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out
}

/// Undoes [`escape`] and the specification's other escapes (`\s`, `\n`,
/// `\t`, `\r`).
pub(crate) fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// One argument of `Exec`: quoted, `"`, `` ` ``, `$` and `\` escaped inside
/// the quotes, `%` doubled (a field code otherwise), then escaped as every
/// string value is (so a backslash is four).
pub(crate) fn exec_arg(arg: &str) -> String {
    let mut quoted = String::from("\"");
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    escape(&quoted)
}
