//! Containers (`:::name[label]{attrs}` … `:::`, as `remark-directive`
//! writes them): `markdown-rs` has no such syntax, so the source is split
//! into Markdown and the declared containers before it is parsed.

use std::{collections::BTreeMap, ops::Range};

use super::super::MarkdownExtension;

/// A part of the source: Markdown, or a declared container.
#[derive(Debug, PartialEq)]
pub(super) enum Segment {
    /// Markdown, at this range of the source.
    Markdown(Range<usize>),
    /// A container of a declared extension.
    Container(Container),
}

/// A container of a declared extension.
#[derive(Debug, PartialEq)]
pub(super) struct Container {
    /// The whole directive, including its fences, in the rewritten source.
    pub(super) range: Range<usize>,
    /// The extension's name.
    pub(super) name: String,
    /// Its label (`label`) and attributes.
    pub(super) attributes: BTreeMap<String, String>,
    /// What it holds.
    pub(super) children: Vec<Segment>,
}

/// `source` split at the containers `extensions` declare.
pub(super) fn split(source: &str, extensions: &[MarkdownExtension]) -> Vec<Segment> {
    let lines = lines(source);
    segments(source, &lines, 0, lines.len(), extensions)
}

/// A line of the source: its range without the line ending, and where the
/// next one starts.
struct Line {
    start: usize,
    end: usize,
    next: usize,
}

fn lines(source: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < source.len() {
        let end = source[start..]
            .find('\n')
            .map_or(source.len(), |i| start + i);
        lines.push(Line {
            start,
            end,
            next: (end + 1).min(source.len()),
        });
        start = end + 1;
    }
    lines
}

fn segments(
    source: &str,
    lines: &[Line],
    from: usize,
    to: usize,
    extensions: &[MarkdownExtension],
) -> Vec<Segment> {
    let mut out = Vec::new();
    let Some(first) = lines.get(from) else {
        return out;
    };
    let mut markdown_start = first.start;
    let mut fence: Option<(u8, usize)> = None;
    let mut i = from;
    while i < to {
        let text = &source[lines[i].start..lines[i].end];
        if let Some((ch, len)) = fence {
            if fence_closes(text, ch, len) {
                fence = None;
            }
            i += 1;
            continue;
        }
        if let Some(open) = fence_opens(text) {
            fence = Some(open);
            i += 1;
            continue;
        }
        let declared = directive(text).and_then(|d| {
            let ext = extensions.iter().find(|e| {
                e.container
                    .as_deref()
                    .is_some_and(|c| c.eq_ignore_ascii_case(d.name))
            })?;
            Some((d, ext))
        });
        let Some((open, ext)) = declared else {
            i += 1;
            continue;
        };
        push_markdown(source, markdown_start..lines[i].start, &mut out);
        let close = closing_line(source, lines, i + 1, to, open.colons);
        let mut attributes = attributes(open.attributes);
        if let Some(label) = open.label {
            attributes.insert("label".into(), label.to_owned());
        }
        out.push(Segment::Container(Container {
            range: lines[i].start..if close < to {
                lines[close].next
            } else {
                lines[to - 1].next
            },
            name: ext.name.to_string(),
            attributes,
            children: segments(source, lines, i + 1, close, extensions),
        }));
        i = close + 1;
        markdown_start = lines.get(i).map_or(source.len(), |l| l.start);
    }
    let end = lines[to - 1].next;
    push_markdown(source, markdown_start..end.max(markdown_start), &mut out);
    out
}

fn push_markdown(source: &str, range: Range<usize>, out: &mut Vec<Segment>) {
    if !source[range.clone()].trim().is_empty() {
        out.push(Segment::Markdown(range));
    }
}

/// The line that closes a container opened with `colons` colons, from line
/// `from`: containers inside, declared or not, close with their own fences.
/// A container nothing closes runs to `to`, the end of what holds it.
fn closing_line(source: &str, lines: &[Line], from: usize, to: usize, colons: usize) -> usize {
    let mut nested: Vec<usize> = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    for (i, line) in lines.iter().enumerate().take(to).skip(from) {
        let text = &source[line.start..line.end];
        if let Some((ch, len)) = fence {
            if fence_closes(text, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_opens(text) {
            fence = Some(open);
        } else if let Some(d) = directive(text) {
            nested.push(d.colons);
        } else if let Some(n) = directive_close(text) {
            match nested.last() {
                Some(&inner) if n >= inner => {
                    nested.pop();
                }
                _ if n >= colons => return i,
                _ => {}
            }
        }
    }
    to
}

/// An opening line: `:::name[label]{attributes}`.
#[derive(Debug, PartialEq)]
struct Directive<'a> {
    colons: usize,
    name: &'a str,
    label: Option<&'a str>,
    attributes: &'a str,
}

fn directive(line: &str) -> Option<Directive<'_>> {
    let rest = strip_indent(line)?;
    let colons = rest.bytes().take_while(|&b| b == b':').count();
    if colons < 3 {
        return None;
    }
    let rest = rest[colons..].trim_start();
    let name_len = rest
        .bytes()
        .enumerate()
        .take_while(|&(i, b)| {
            if i == 0 {
                b.is_ascii_alphabetic()
            } else {
                b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
            }
        })
        .count();
    if name_len == 0 {
        return None;
    }
    let name = &rest[..name_len];
    let mut rest = &rest[name_len..];
    let mut label = None;
    if let Some(after) = rest.strip_prefix('[') {
        let end = after.find(']')?;
        label = Some(&after[..end]);
        rest = &after[end + 1..];
    }
    let mut attributes = "";
    let trimmed = rest.trim_start();
    if let Some(after) = trimmed.strip_prefix('{') {
        let end = after.find('}')?;
        attributes = &after[..end];
        rest = &after[end + 1..];
    }
    rest.trim().is_empty().then_some(Directive {
        colons,
        name,
        label,
        attributes,
    })
}

/// The number of colons of a closing line (`:::`).
fn directive_close(line: &str) -> Option<usize> {
    let rest = strip_indent(line)?.trim_end();
    let colons = rest.bytes().take_while(|&b| b == b':').count();
    (colons >= 3 && colons == rest.len()).then_some(colons)
}

/// `{key=value key2="v 2" .class #id flag}` read.
fn attributes(source: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut classes: Vec<&str> = Vec::new();
    let mut rest = source.trim();
    while !rest.is_empty() {
        let key_len = rest
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let key = &rest[..key_len];
        rest = rest[key_len..].trim_start();
        let mut value = "";
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            match after.chars().next() {
                Some(quote @ ('"' | '\'')) => {
                    let body = &after[1..];
                    let end = body.find(quote).unwrap_or(body.len());
                    value = &body[..end];
                    rest = body.get(end + 1..).unwrap_or("");
                }
                _ => {
                    let end = after.find(char::is_whitespace).unwrap_or(after.len());
                    value = &after[..end];
                    rest = &after[end..];
                }
            }
        }
        rest = rest.trim_start();
        if let Some(class) = key.strip_prefix('.') {
            if !class.is_empty() {
                classes.push(class);
            }
        } else if let Some(id) = key.strip_prefix('#') {
            if !id.is_empty() {
                out.insert("id".into(), id.to_owned());
            }
        } else if !key.is_empty() {
            out.insert(key.to_owned(), value.to_owned());
        }
    }
    if !classes.is_empty() {
        out.insert("class".into(), classes.join(" "));
    }
    out
}

/// `line` without up to three spaces of indentation (four make it code).
fn strip_indent(line: &str) -> Option<&str> {
    let indent = line.bytes().take_while(|&b| b == b' ').count();
    (indent < 4).then(|| &line[indent..])
}

/// The character and length of the code fence `line` opens (```` ``` ````,
/// `~~~`).
pub(super) fn fence_opens(line: &str) -> Option<(u8, usize)> {
    let rest = strip_indent(line)?;
    let ch = *rest.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = rest.bytes().take_while(|&b| b == ch).count();
    // A backtick fence's info string has no backticks (else it is code in
    // a paragraph).
    (len >= 3 && !(ch == b'`' && rest[len..].contains('`'))).then_some((ch, len))
}

/// Whether `line` closes a fence of `len` characters `ch`.
pub(super) fn fence_closes(line: &str, ch: u8, len: usize) -> bool {
    let Some(rest) = strip_indent(line) else {
        return false;
    };
    let rest = rest.trim_end();
    let n = rest.bytes().take_while(|&b| b == ch).count();
    n >= len && n == rest.len()
}

/// `line` without the quote markers and list markers before its content,
/// so fences inside quotes and list items are seen.
pub(super) fn strip_containers(mut line: &str) -> &str {
    loop {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if let Some(rest) = trimmed.strip_prefix('>') {
            line = rest;
            continue;
        }
        let bullet = trimmed
            .strip_prefix(['-', '*', '+'])
            .or_else(|| {
                let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
                (digits > 0 && digits < 10)
                    .then(|| trimmed[digits..].strip_prefix(['.', ')']))
                    .flatten()
            })
            .filter(|rest| rest.starts_with([' ', '\t']));
        match bullet {
            Some(rest) => line = rest,
            None => return trimmed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(
        range: Range<usize>,
        name: &str,
        attrs: &[(&str, &str)],
        children: Vec<Segment>,
    ) -> Segment {
        Segment::Container(Container {
            range,
            name: name.into(),
            attributes: attrs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
            children,
        })
    }

    #[test]
    fn splits_declared_containers() {
        let exts = [MarkdownExtension::container("note", "note")];
        let src = "a\n\n:::note[Heads up]{kind=tip .x .y #n q=\"a b\"}\nin\n:::\nb\n";
        assert_eq!(
            split(src, &exts),
            vec![
                Segment::Markdown(0..3),
                container(
                    3..55,
                    "note",
                    &[
                        ("label", "Heads up"),
                        ("kind", "tip"),
                        ("class", "x y"),
                        ("id", "n"),
                        ("q", "a b")
                    ],
                    vec![Segment::Markdown(48..51)]
                ),
                Segment::Markdown(55..57),
            ]
        );
    }

    #[test]
    fn nesting_fences_and_unknown_names() {
        let exts = [MarkdownExtension::container("box", "box")];
        // The inner unknown container's closing fence does not close the
        // box, a fence in code does not either, and an unclosed box runs
        // to the end.
        let src = ":::box\n:::other\nx\n:::\n```\n:::\n```\n";
        let segs = split(src, &exts);
        assert_eq!(
            segs,
            vec![container(
                0..src.len(),
                "box",
                &[],
                vec![Segment::Markdown(7..src.len())]
            )]
        );
        // Longer fences nest by length.
        let src = "::::box\n:::box\ni\n:::\n::::\nafter";
        let segs = split(src, &exts);
        assert_eq!(
            segs,
            vec![
                container(
                    0..26,
                    "box",
                    &[],
                    vec![container(
                        8..21,
                        "box",
                        &[],
                        vec![Segment::Markdown(15..17)]
                    )]
                ),
                Segment::Markdown(26..31),
            ]
        );
        assert_eq!(
            split(":::nope\nx\n:::", &exts),
            vec![Segment::Markdown(0..13)]
        );
    }
}
