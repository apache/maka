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

//! Source addresses for the presentation produced by the existing Markdown AST.
//! Literal ranges retain exact UTF-8 addresses; lexical replacements are atomic.

use ::markdown::mdast::Node;
use nsh_core::{TextSourceKind, TextSourceSegment};

fn start(node: &Node) -> usize {
    node.position().map_or(0, |p| p.start.offset)
}
fn raw<'a>(source: &'a str, node: &Node) -> &'a str {
    node.position()
        .and_then(|p| source.get(p.start.offset..p.end.offset))
        .unwrap_or("")
}

pub(crate) fn literal(offset: usize, text: &str) -> Vec<TextSourceSegment> {
    if text.is_empty() {
        return Vec::new();
    }
    vec![TextSourceSegment {
        start: 0,
        end: text.encode_utf16().count() as u32,
        source_start: offset as u64,
        source_end: (offset + text.len()) as u64,
        kind: TextSourceKind::Literal,
    }]
}

struct Projection<'a> {
    expected: &'a str,
    bytes: usize,
    units: u32,
    segments: Vec<TextSourceSegment>,
}

impl<'a> Projection<'a> {
    fn new(expected: &'a str) -> Self {
        Self {
            expected,
            bytes: 0,
            units: 0,
            segments: Vec::new(),
        }
    }

    fn remaining(&self) -> &'a str {
        &self.expected[self.bytes..]
    }

    fn push(
        &mut self,
        text: &str,
        source_start: usize,
        source_end: usize,
        kind: TextSourceKind,
    ) -> Result<(), String> {
        if !self.remaining().starts_with(text) {
            return Err(format!(
                "Markdown source projection disagrees with parsed text at byte {source_start}"
            ));
        }
        let end = self.units + text.encode_utf16().count() as u32;
        if !text.is_empty() {
            if kind == TextSourceKind::Literal
                && let Some(previous) = self.segments.last_mut()
                && previous.kind == kind
                && previous.source_end == source_start as u64
            {
                previous.end = end;
                previous.source_end = source_end as u64;
            } else {
                self.segments.push(TextSourceSegment {
                    start: self.units,
                    end,
                    source_start: source_start as u64,
                    source_end: source_end as u64,
                    kind,
                });
            }
        }
        self.bytes += text.len();
        self.units = end;
        Ok(())
    }

    fn finish(self) -> Result<Vec<TextSourceSegment>, String> {
        if self.bytes != self.expected.len() {
            return Err("Markdown source projection did not cover the parsed text".into());
        }
        Ok(self.segments)
    }
}

/// A Text leaf can contain escaped punctuation, entities and continuation
/// container prefixes. Replay those lexical transformations, never search the
/// document for a rendered substring (repeated text has a different address).
pub(super) fn text(
    source: &str,
    node: &Node,
    expected: &str,
    quote: u32,
) -> Result<Vec<TextSourceSegment>, String> {
    let input = raw(source, node);
    if input == expected {
        return Ok(literal(start(node), input));
    }
    let mut result = Projection::new(expected);
    let mut offset = 0;
    let mut line_start = false;
    while offset < input.len() && !result.remaining().is_empty() {
        let rest = &input[offset..];
        let base = start(node) + offset;
        let ch = rest.chars().next().unwrap();
        if line_start {
            // Prose strips literal indentation after a soft line ending.
            // A rendered leading space may instead come from an entity later
            // on this line, so do not consume any parsed text for this gap.
            let consumed = continuation_length(rest, quote);
            line_start = false;
            if consumed != 0 {
                offset += consumed;
                continue;
            }
        }
        if matches!(ch, ' ' | '\t') {
            let end = rest.len() - rest.trim_start_matches([' ', '\t']).len();
            if rest[end..].starts_with(['\r', '\n']) {
                // The Text tokenizer drops trailing literal whitespace;
                // actual hard breaks have their own AST node and source map.
                offset += end;
                continue;
            }
            result.push(&rest[..end], base, base + end, TextSourceKind::Literal)?;
            offset += end;
            continue;
        }
        if ch == '\\'
            && let Some(escaped) = rest.chars().nth(1)
            && escaped.is_ascii_punctuation()
        {
            let consumed = 1 + escaped.len_utf8();
            result.push(
                &rest[1..consumed],
                base,
                base + consumed,
                TextSourceKind::Replacement,
            )?;
            offset += consumed;
            continue;
        }
        if ch == '&'
            && let Some((consumed, decoded)) = reference(rest)
            && result.remaining().starts_with(&decoded)
        {
            result.push(&decoded, base, base + consumed, TextSourceKind::Replacement)?;
            offset += consumed;
            continue;
        }
        if ch == '\0' && result.remaining().starts_with('�') {
            result.push("�", base, base + 1, TextSourceKind::Replacement)?;
            offset += 1;
            continue;
        }
        if matches!(ch, '\r' | '\n') && result.remaining().starts_with([' ', '\n']) {
            let consumed = if rest.starts_with("\r\n") { 2 } else { 1 };
            let rendered = if result.remaining().starts_with(' ') {
                " "
            } else {
                "\n"
            };
            result.push(rendered, base, base + consumed, TextSourceKind::Replacement)?;
            offset += consumed;
            line_start = true;
            continue;
        }
        result.push(
            &rest[..ch.len_utf8()],
            base,
            base + ch.len_utf8(),
            TextSourceKind::Literal,
        )?;
        offset += ch.len_utf8();
        if matches!(ch, '\n' | '\r') {
            line_start = true;
        }
    }
    result.finish()
}

fn reference(input: &str) -> Option<(usize, String)> {
    let end = 1 + input.as_bytes()[1..]
        .iter()
        .position(|byte| !byte.is_ascii_alphanumeric() && *byte != b'#')?;
    if input.as_bytes()[end] != b';' {
        return None;
    }
    let name = &input[1..end];
    let decoded = if let Some(number) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
    {
        // Match markdown-rs' character-reference grammar (CommonMark), rather
        // than decoding invalid long literals merely because u32 accepts them.
        if number.is_empty()
            || number.len() > 6
            || !number.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        u32::from_str_radix(number, 16).ok()?;
        ::markdown::decode_numeric(number, 16)
    } else if let Some(number) = name.strip_prefix('#') {
        if number.is_empty()
            || number.len() > 7
            || !number.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        number.parse::<u32>().ok()?;
        ::markdown::decode_numeric(number, 10)
    } else {
        ::markdown::decode_named(name, true)?
    };
    Some((end + 1, decoded))
}

pub(super) fn inline_code(
    source: &str,
    node: &Node,
    expected: &str,
    quote: u32,
) -> Result<Vec<TextSourceSegment>, String> {
    let input = raw(source, node);
    let fence = input.bytes().take_while(|byte| *byte == b'`').count();
    let mut first = fence;
    let mut last = input.len() - fence;
    let body = &input[first..last];
    // CommonMark removes one surrounding space, except for all-space code.
    if body.starts_with(' ') && body.ends_with(' ') && body.chars().any(|ch| ch != ' ') {
        first += 1;
        last -= 1;
    }
    if &input[first..last] == expected {
        return Ok(literal(start(node) + first, expected));
    }
    let mut result = Projection::new(expected);
    let mut offset = first;
    let mut line_start = false;
    while offset < last {
        let rest = &input[offset..last];
        let ch = rest.chars().next().unwrap();
        let base = start(node) + offset;
        if line_start {
            let consumed = code_continuation(&mut result, rest, base, quote)?;
            line_start = false;
            if consumed != 0 {
                offset += consumed;
                continue;
            }
        }
        let consumed = if rest.starts_with("\r\n") {
            2
        } else {
            ch.len_utf8()
        };
        if matches!(ch, '\r' | '\n') && result.remaining().starts_with(' ') {
            result.push(" ", base, base + consumed, TextSourceKind::Replacement)?;
        } else if rest.starts_with("\\|") && result.remaining().starts_with('|') {
            result.push("|", base, base + 2, TextSourceKind::Replacement)?;
            offset += 2;
            continue;
        } else {
            result.push(
                &rest[..consumed],
                base,
                base + consumed,
                TextSourceKind::Literal,
            )?;
        }
        offset += consumed;
        line_start = matches!(ch, '\r' | '\n');
    }
    result.finish()
}

pub(super) fn continuation_length(input: &str, quote: u32) -> usize {
    let mut quotes = 0;
    let mut consumed = 0;
    for ch in input.chars() {
        if matches!(ch, ' ' | '\t') || (ch == '>' && quotes < quote) {
            if ch == '>' {
                quotes += 1;
            }
            consumed += ch.len_utf8();
        } else {
            break;
        }
    }
    consumed
}

/// Inline code retains indentation left after its container prefix. Keep that
/// whitespace as one lexical token rather than guessing among equal spaces.
fn code_continuation(
    result: &mut Projection<'_>,
    input: &str,
    base: usize,
    quote: u32,
) -> Result<usize, String> {
    let consumed = continuation_length(input, quote);
    if consumed != 0 {
        let remaining = result.remaining();
        let end = remaining.len() - remaining.trim_start_matches([' ', '\t']).len();
        result.push(
            &remaining[..end],
            base,
            base + consumed,
            TextSourceKind::Replacement,
        )?;
    }
    Ok(consumed)
}

pub(super) fn line_break(source: &str, node: &Node) -> Vec<TextSourceSegment> {
    vec![TextSourceSegment {
        start: 0,
        end: 1,
        source_start: start(node) as u64,
        source_end: (start(node) + raw(source, node).len()) as u64,
        kind: TextSourceKind::Replacement,
    }]
}

/// The parser's code value consists of source lines with their container,
/// indentation and fence removed. Match only that line's exact retained suffix;
/// the discarded prefix must consist of container/indentation characters.
pub(super) fn code(
    source: &str,
    node: &Node,
    expected: &str,
) -> Result<Vec<TextSourceSegment>, String> {
    let input = raw(source, node);
    let mut source_offset = 0;
    let first_line = &input[..line_end(input)];
    let fence = first_line.trim_start_matches([' ', '\t']);
    // CommonMark permits at most three columns before a fence. Four columns
    // (including a tab stop) instead introduce literal indented code.
    let columns = first_line[..first_line.len() - fence.len()]
        .chars()
        .fold(
            0,
            |at, ch| {
                if ch == '\t' { at + 4 - at % 4 } else { at + 1 }
            },
        );
    let fenced = matches!(node, Node::Math(_))
        || columns < 4 && (fence.starts_with("```") || fence.starts_with("~~~"));
    if fenced {
        source_offset += first_line.len();
    }
    let mut result = Projection::new(expected);
    while !result.remaining().is_empty() {
        let rest = &input[source_offset..];
        let end = line_end(rest);
        if end == 0 {
            return Err("Markdown code source ended before its parsed value".into());
        }
        let source_line = &rest[..end];
        let content = source_line.trim_end_matches(['\r', '\n']);
        let rendered = result.remaining();
        let rendered_end = rendered.find(['\r', '\n']).unwrap_or(rendered.len());
        let rendered_line = &rendered[..rendered_end];
        let (prefix, leading) = if let Some(prefix) = content.strip_suffix(rendered_line) {
            (prefix, "")
        } else {
            // A tab consumed partly by indentation can leave rendered spaces.
            // Keep that indentation as one lexical replacement, never the code.
            let tail = rendered_line.trim_start_matches([' ', '\t']);
            let prefix = content
                .strip_suffix(tail)
                .ok_or("Markdown code line is not an exact source suffix")?;
            (prefix, &rendered_line[..rendered_line.len() - tail.len()])
        };
        if !prefix.chars().all(|ch| matches!(ch, ' ' | '\t' | '>')) {
            return Err("Markdown code discarded a non-container source prefix".into());
        }
        let base = start(node) + source_offset;
        if !leading.is_empty() {
            result.push(
                leading,
                base,
                base + prefix.len(),
                TextSourceKind::Replacement,
            )?;
        }
        let kept = &content[prefix.len()..];
        result.push(
            kept,
            base + prefix.len(),
            base + content.len(),
            TextSourceKind::Literal,
        )?;
        if rendered_end < rendered.len() {
            let ending = if rendered[rendered_end..].starts_with("\r\n") {
                "\r\n"
            } else {
                &rendered[rendered_end..rendered_end + 1]
            };
            let raw_ending = &source_line[content.len()..];
            let kind = if raw_ending == ending {
                TextSourceKind::Literal
            } else {
                TextSourceKind::Replacement
            };
            let base = start(node) + source_offset + content.len();
            result.push(
                ending,
                base,
                start(node) + source_offset + source_line.len(),
                kind,
            )?;
        }
        source_offset += source_line.len();
    }
    result.finish()
}

fn line_end(source: &str) -> usize {
    source.find(['\r', '\n']).map_or(source.len(), |at| {
        at + if source[at..].starts_with("\r\n") {
            2
        } else {
            1
        }
    })
}
