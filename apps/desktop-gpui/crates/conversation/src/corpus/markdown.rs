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

//! The text a person sees of a Markdown reply, with where each character
//! of it comes from in the source, read with the parser and the parse
//! options gpui-kit's text view uses (`markdown` 1.0, GFM with math, no
//! frontmatter, no MDX: what `MarkdownExtensions::default` asks for, and
//! the transcript gives its replies no other).
//!
//! Only text the view draws in a text leaf, and whose source the view can
//! map back (`RenderedText::range_for_source`), is taken: paragraphs,
//! headings, list items, block quotes, table cells, code blocks, inline
//! code, and the visible text of links. Markup characters, link
//! destinations, images, HTML (whose text the view draws without source
//! positions) and footnote markers are left out, so a find neither counts
//! what it could not paint nor matches what the reader cannot see.
//!
//! Text is decoded as the view decodes it (`\*` reads `*`, `&amp;` reads
//! `&`, a soft line break reads as a space), each leaf ends with a line
//! break of its own (mapped to nothing), so no match spans two leaves.

use std::ops::Range;

use markdown::ParseOptions;
use markdown::mdast::Node;

/// Where a run of the visible text comes from in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Segment {
    text: Range<usize>,
    source: Range<usize>,
    /// The run maps byte for byte (no escape, entity or line ending in it).
    linear: bool,
}

/// A reply's visible text and its map back to the Markdown source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct VisibleText {
    text: String,
    segments: Vec<Segment>,
}

impl VisibleText {
    /// The text a person sees, a line per leaf.
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    /// The source a range of [`Self::text`] was rendered from: from where
    /// its first character comes to where its last one ends. `None` when
    /// either end maps to nothing.
    pub(crate) fn source_range(&self, range: Range<usize>) -> Option<Range<usize>> {
        let last = self.text[..range.end].char_indices().next_back()?.0;
        let start = self.source_of(range.start)?.start;
        let end = self.source_of(last)?.end;
        (start < end).then_some(start..end)
    }

    /// The source of the character at byte `at` of the text.
    fn source_of(&self, at: usize) -> Option<Range<usize>> {
        let ix = self.segments.partition_point(|segment| segment.text.end <= at);
        let segment = self.segments.get(ix).filter(|segment| segment.text.start <= at)?;
        if !segment.linear {
            return Some(segment.source.clone());
        }
        let start = segment.source.start + (at - segment.text.start);
        let len = self.text[at..].chars().next().map_or(0, char::len_utf8);
        Some(start..start + len)
    }
}

/// The parse options of gpui-kit's text view with its default extensions
/// (`MarkdownExtensions::parse_options`): GFM, inline and block math on.
fn parse_options() -> ParseOptions {
    let mut options = ParseOptions::gfm();
    options.constructs.frontmatter = false;
    options.constructs.math_text = true;
    options.constructs.math_flow = true;
    options
}

/// The visible text of `source`, a Markdown reply.
pub(crate) fn visible_text(source: &str) -> VisibleText {
    let mut builder = Builder { source, base: 0, out: VisibleText::default() };
    if let Ok(Node::Root(root)) = markdown::to_mdast(source, &parse_options()) {
        builder.blocks(&root.children);
    }
    builder.out
}

struct Builder<'a> {
    source: &'a str,
    /// Where the positions of the nodes being walked start in `source`:
    /// 0, or the start of an inline math span parsed again on its own.
    base: usize,
    out: VisibleText,
}

impl Builder<'_> {
    fn span(&self, node: &Node) -> Option<Range<usize>> {
        let position = node.position()?;
        let span = self.base + position.start.offset..self.base + position.end.offset;
        (span.end <= self.source.len()).then_some(span)
    }

    fn blocks(&mut self, nodes: &[Node]) {
        for node in nodes {
            self.block(node);
        }
    }

    fn block(&mut self, node: &Node) {
        match node {
            Node::Paragraph(paragraph) => self.leaf(&paragraph.children),
            Node::Heading(heading) => self.leaf(&heading.children),
            Node::Blockquote(quote) => self.blocks(&quote.children),
            Node::List(list) => self.blocks(&list.children),
            Node::ListItem(item) => self.blocks(&item.children),
            // The view joins a definition's blocks into one paragraph after
            // a marker of its own; the blocks' text is the reply's.
            Node::FootnoteDefinition(definition) => self.blocks(&definition.children),
            Node::Table(table) => {
                for row in &table.children {
                    for cell in row.children().into_iter().flatten() {
                        if let Some(children) = cell.children() {
                            self.leaf(children);
                        }
                    }
                }
            }
            Node::Code(code) => {
                if let Some(span) = self.span(node) {
                    self.align(&code.value, span, false);
                }
                self.end_leaf();
            }
            Node::Math(math) => {
                if let Some(span) = self.span(node) {
                    self.align(&math.value, span, false);
                }
                self.end_leaf();
            }
            // HTML blocks render without source positions; rules,
            // definitions and breaks render no text.
            _ => {}
        }
    }

    fn leaf(&mut self, children: &[Node]) {
        self.inlines(children);
        self.end_leaf();
    }

    fn end_leaf(&mut self) {
        if !self.out.text.is_empty() && !self.out.text.ends_with('\n') {
            self.out.text.push('\n');
        }
    }

    fn inlines(&mut self, nodes: &[Node]) {
        for node in nodes {
            self.inline(node);
        }
    }

    fn inline(&mut self, node: &Node) {
        match node {
            Node::Text(text) => {
                // A soft line break reads as a space, as the view draws it.
                let decoded = text.value.replace("\r\n", " ").replace(['\n', '\r'], " ");
                if let Some(span) = self.span(node) {
                    self.align(&decoded, span, true);
                }
            }
            Node::InlineCode(code) => {
                if let Some(span) = self.span(node) {
                    self.align(&code.value, span, false);
                }
            }
            Node::Emphasis(_)
            | Node::Strong(_)
            | Node::Delete(_)
            | Node::Link(_)
            | Node::LinkReference(_) => {
                self.inlines(node.children().map_or(&[][..], Vec::as_slice));
            }
            // A hard break is a line of its own: no match crosses it.
            Node::Break(_) => self.out.text.push('\n'),
            Node::InlineMath(_) => self.inline_math(node),
            // Inline HTML tags, images and footnote markers.
            _ => {}
        }
    }

    /// Inline math no plugin claims, as the view draws it: the literal
    /// source, dollars included, unless that source holds inline markup,
    /// which is then read as ordinary text (gpui-kit's
    /// `flatten_unclaimed_math`).
    fn inline_math(&mut self, node: &Node) {
        let Some(span) = self.span(node) else { return };
        let literal = &self.source[span.clone()];
        if may_hold_inline_markup(literal) {
            let mut prose = parse_options();
            prose.constructs.math_text = false;
            prose.constructs.math_flow = false;
            if let Ok(Node::Root(root)) = markdown::to_mdast(literal, &prose)
                && let [Node::Paragraph(paragraph)] = root.children.as_slice()
                && !paragraph.children.iter().all(|child| matches!(child, Node::Text(_)))
            {
                let base = std::mem::replace(&mut self.base, span.start);
                self.inlines(&paragraph.children);
                self.base = base;
                return;
            }
        }
        let start = self.out.text.len();
        self.out.text.push_str(literal);
        self.push(start..self.out.text.len(), span, true);
    }

    /// Appends `decoded`, the text a node renders, mapping each character
    /// to where it stands in `span` of the source: the same character, an
    /// escape (`\*`), an entity (`&amp;`), a line ending a space stands
    /// for, or the next place it occurs (text the parser dropped
    /// indentation or quote markers from). A character found nowhere maps
    /// to nothing.
    fn align(&mut self, decoded: &str, span: Range<usize>, decode: bool) {
        let raw = &self.source[span.clone()];
        let mut cursor = 0;
        for c in decoded.chars() {
            let rest = &raw[cursor..];
            let found = if rest.starts_with(c) {
                Some((0, c.len_utf8()))
            } else if decode
                && let Some(escaped) = rest.strip_prefix('\\')
                && escaped.starts_with(c)
            {
                Some((0, 1 + c.len_utf8()))
            } else if decode && let Some(len) = entity_len(rest) {
                Some((0, len))
            } else if c == ' '
                && let Some((at, len)) = line_ending(rest)
            {
                Some((at, len))
            } else {
                rest.find(c).map(|at| (at, c.len_utf8()))
            };
            let start = self.out.text.len();
            self.out.text.push(c);
            let Some((at, len)) = found else { continue };
            let source = span.start + cursor + at..span.start + cursor + at + len;
            self.push(start..self.out.text.len(), source, len == c.len_utf8());
            cursor += at + len;
        }
    }

    /// Records that `text` came from `source`, merging a run that goes on
    /// byte for byte from the one before.
    fn push(&mut self, text: Range<usize>, source: Range<usize>, linear: bool) {
        if let Some(previous) = self.out.segments.last_mut()
            && previous.linear
            && linear
            && previous.text.end == text.start
            && previous.source.end == source.start
        {
            previous.text.end = text.end;
            previous.source.end = source.end;
            return;
        }
        self.out.segments.push(Segment { text, source, linear });
    }
}

/// The length of the character reference `rest` starts with (`&amp;`,
/// `&#38;`, `&#x26;`), if it starts with one.
fn entity_len(rest: &str) -> Option<usize> {
    let name = rest.strip_prefix('&')?;
    let end = name.bytes().take(32).position(|byte| byte == b';')?;
    let valid = end > 0
        && name.as_bytes()[..end].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'#');
    valid.then_some(end + 2)
}

/// A line ending after optional spaces at the start of `rest`, where a
/// soft line break the view draws as a space stands: its offset and length.
fn line_ending(rest: &str) -> Option<(usize, usize)> {
    let at = rest.bytes().position(|byte| !matches!(byte, b' ' | b'\t'))?;
    match &rest[at..] {
        ending if ending.starts_with("\r\n") => Some((at, 2)),
        ending if ending.starts_with('\n') || ending.starts_with('\r') => Some((at, 1)),
        _ => None,
    }
}

/// gpui-kit's gate before it parses unclaimed math again: every inline
/// construct starts with one of these bytes, or is a GFM autolink literal.
fn may_hold_inline_markup(literal: &str) -> bool {
    literal
        .bytes()
        .any(|byte| matches!(byte, b'<' | b'*' | b'_' | b'[' | b'`' | b'~' | b'\\' | b'!' | b'&'))
        || literal.contains("://")
        || literal.contains("www.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each match of `needle` in the visible text, with the source it maps
    /// to.
    fn sources<'a>(source: &'a str, needle: &str) -> Vec<&'a str> {
        let visible = visible_text(source);
        visible
            .text()
            .match_indices(needle)
            .filter_map(|(at, found)| visible.source_range(at..at + found.len()))
            .map(|range| &source[range])
            .collect()
    }

    #[test]
    fn markup_stays_out_of_the_text() {
        let source = "Use **bold**, `code` and [the docs](https://example.com/path \"Title\").";
        let visible = visible_text(source);
        assert_eq!(visible.text(), "Use bold, code and the docs.\n");
        assert_eq!(sources(source, "bold"), ["bold"]);
        assert_eq!(sources(source, "code"), ["code"]);
        assert_eq!(sources(source, "the docs"), ["the docs"]);
        assert!(!visible.text().contains("example.com"), "no link target");
        assert!(!visible.text().contains('*'));
    }

    #[test]
    fn a_match_across_marked_runs_maps_to_the_source_between_them() {
        assert_eq!(sources("foo **bar** baz", "foo bar"), ["foo **bar"]);
        assert_eq!(sources("*a* and _b_", "a and b"), ["a* and _b"]);
    }

    #[test]
    fn decoded_text_maps_to_its_escapes_entities_and_line_endings() {
        assert_eq!(visible_text("a \\* b").text(), "a * b\n");
        assert_eq!(sources("a \\* b", "* b"), ["\\* b"]);
        assert_eq!(sources("fish &amp; chips", "& chips"), ["&amp; chips"]);
        assert_eq!(visible_text("one\ntwo").text(), "one two\n", "a soft break is a space");
        assert_eq!(sources("one\ntwo", "one two"), ["one\ntwo"]);
    }

    #[test]
    fn blocks_are_leaves_of_their_own() {
        let source = "# Title\n\n- first item\n- second\n\n> quoted\n\n```rust\nlet x = 1;\n```\n";
        assert_eq!(visible_text(source).text(), "Title\nfirst item\nsecond\nquoted\nlet x = 1;\n");
        assert_eq!(sources(source, "let x"), ["let x"]);
        assert!(sources(source, "Title first").is_empty(), "no match spans two leaves");
        assert!(sources(source, "rust").is_empty(), "a fence's language is not text");
    }

    #[test]
    fn table_cells_and_list_text_keep_their_sources() {
        let source = "| Name | Size |\n| --- | --- |\n| alpha | 10 |\n";
        assert_eq!(visible_text(source).text(), "Name\nSize\nalpha\n10\n");
        assert_eq!(sources(source, "alpha"), ["alpha"]);
        let nested = "1. one\n   continued\n2. two";
        assert_eq!(sources(nested, "one continued"), ["one\n   continued"]);
    }

    #[test]
    fn html_images_and_footnote_markers_are_left_out() {
        let source = "<div>block html</div>\n\nSee ![alt text](a.png) and <b>bold</b>[^1].\n\n[^1]: The note.";
        let text = visible_text(source).text().to_owned();
        assert!(!text.contains("block html"), "{text:?}");
        assert!(!text.contains("alt text"), "{text:?}");
        assert!(text.contains("See  and bold."), "{text:?}");
        assert!(text.contains("The note."), "{text:?}");
    }

    #[test]
    fn unclaimed_math_reads_as_its_literal_source() {
        let source = "It costs $5 and $10 now.";
        assert_eq!(visible_text(source).text(), "It costs $5 and $10 now.\n");
        assert_eq!(sources(source, "$5 and $10"), ["$5 and $10"]);
        // With markup inside, the span is ordinary text again.
        let marked = "Pay $a **b** c$ now";
        assert_eq!(visible_text(marked).text(), "Pay $a b c$ now\n");
        assert_eq!(sources(marked, "b c"), ["b** c"]);
    }

    #[test]
    fn chinese_text_maps_byte_for_byte() {
        let source = "运行**测试**通过";
        assert_eq!(visible_text(source).text(), "运行测试通过\n");
        assert_eq!(sources(source, "测试"), ["测试"]);
    }
}
