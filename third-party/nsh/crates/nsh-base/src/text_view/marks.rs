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

//! Clickable inline passage marks overlaid on a parsed [`Document`].
//!
//! Matching runs on the parsed AST prose leaves (skipping code blocks,
//! inline code, math, and links) so Markdown syntax, table cells, and
//! `afterByte` anchors are never disturbed.

use std::{collections::HashMap, ops::Range};

use nsh_core::{TextSourceKind, TextSourceSegment, keymap::Modifiers, prelude::*};

use super::document::{Block, Document, Inline, inline_text};

/// A passage annotation on a [`super::TextView`]'s prose: underlined and
/// clickable without modifying Markdown source or `afterByte` anchors.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TextViewMark {
    /// App-owned identifier reported by `onMarkPress` and `onMarksMatch`.
    pub id: SharedString,
    /// Tooltip shown on hover and accessibility hint.
    pub title: Option<SharedString>,
    /// Plain-text passages to find and underline (as selected from the view).
    pub quotes: Vec<SharedString>,
    /// Highlighted as active (for example while its side card is open).
    pub active: Option<bool>,
}

/// A press on a marked passage (`onMarkPress`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct TextViewMarkPressEvent {
    /// Identifier of the pressed [`TextViewMark`].
    pub id: SharedString,
    /// Modifiers held on the press.
    pub modifiers: Modifiers,
}

/// Which [`TextViewMark`] ids matched at least one passage in the document (`onMarksMatch`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct TextViewMarksMatchEvent {
    /// Matched mark ids, in the order they appear in `marks`.
    pub ids: Vec<SharedString>,
}

struct Piece {
    plain_start: usize,
    plain_end: usize,
    /// `Some(leaf_id)` for markable prose leaves; `None` for inline code,
    /// links, math, and other non-markable inline runs whose visible text
    /// still participates in matching surrounding prose.
    leaf_id: Option<usize>,
}

struct Container {
    plain: String,
    pieces: Vec<Piece>,
    taken: Vec<Range<usize>>,
}

impl Container {
    fn new() -> Self {
        Self {
            plain: String::new(),
            pieces: Vec::new(),
            taken: Vec::new(),
        }
    }

    fn push(&mut self, text: &str, leaf_id: Option<usize>) {
        if text.is_empty() {
            return;
        }
        let plain_start = self.plain.len();
        self.plain.push_str(text);
        let plain_end = self.plain.len();
        self.pieces.push(Piece {
            plain_start,
            plain_end,
            leaf_id,
        });
    }

    fn overlaps_taken(&self, range: &Range<usize>) -> bool {
        self.taken
            .iter()
            .any(|used| range.start < used.end && range.end > used.start)
    }
}

fn collect_inlines(inlines: &[Inline], container: &mut Container, next_leaf: &mut usize) {
    for inline in inlines {
        match inline {
            Inline::Text { text } => {
                let id = *next_leaf;
                *next_leaf += 1;
                container.push(text, Some(id));
            }
            Inline::Source { content, .. }
            | Inline::Strong { content }
            | Inline::Emphasis { content }
            | Inline::Strikethrough { content }
            | Inline::Underline { content }
            | Inline::Highlight { content, .. }
            | Inline::TextStyle { content, .. }
            | Inline::Superscript { content }
            | Inline::Subscript { content }
            | Inline::Small { content } => collect_inlines(content, container, next_leaf),
            Inline::Code { code } => container.push(code, None),
            Inline::Keyboard { text } => container.push(text, None),
            Inline::Math { tex } => container.push(tex, None),
            Inline::Link { content, .. } | Inline::Mark { content, .. } => {
                let mut text = String::new();
                inline_text(content, &mut text);
                container.push(&text, None);
            }
            Inline::Break => container.push("\n", None),
            Inline::Image(_) | Inline::FootnoteReference { .. } | Inline::Custom(_) => {}
        }
    }
}

fn collect_blocks(blocks: &[Block], containers: &mut Vec<Container>, next_leaf: &mut usize) {
    for block in blocks {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                let mut container = Container::new();
                collect_inlines(content, &mut container, next_leaf);
                if !container.plain.is_empty() {
                    containers.push(container);
                }
            }
            Block::Blockquote { children, .. } => collect_blocks(children, containers, next_leaf),
            Block::List { items, .. } => {
                for item in items {
                    collect_blocks(&item.children, containers, next_leaf);
                }
            }
            Block::Table(table) => {
                for row in std::iter::once(&table.head).chain(table.rows.iter()) {
                    for cell in row {
                        let mut container = Container::new();
                        collect_inlines(&cell.content, &mut container, next_leaf);
                        if !container.plain.is_empty() {
                            containers.push(container);
                        }
                    }
                }
            }
            Block::Details {
                summary, children, ..
            } => {
                let mut container = Container::new();
                collect_inlines(summary, &mut container, next_leaf);
                if !container.plain.is_empty() {
                    containers.push(container);
                }
                collect_blocks(children, containers, next_leaf);
            }
            Block::CodeBlock(_) | Block::Math { .. } | Block::Rule | Block::Custom(_) => {}
        }
    }
}

fn slice_segments(
    text: &str,
    segments: &[TextSourceSegment],
    range: Range<usize>,
) -> Vec<TextSourceSegment> {
    let u16_start = text[..range.start].encode_utf16().count() as u32;
    let u16_end = u16_start + text[range].encode_utf16().count() as u32;
    let mut out = Vec::new();
    for seg in segments {
        let lo = seg.start.max(u16_start);
        let hi = seg.end.min(u16_end);
        if lo >= hi {
            continue;
        }
        let (source_start, source_end) = if seg.kind == TextSourceKind::Literal {
            let seg_byte = nsh_core::text_edit::utf16_to_byte(text, seg.start);
            let lo_byte = nsh_core::text_edit::utf16_to_byte(text, lo);
            let hi_byte = nsh_core::text_edit::utf16_to_byte(text, hi);
            (
                seg.source_start + (lo_byte - seg_byte) as u64,
                seg.source_start + (hi_byte - seg_byte) as u64,
            )
        } else {
            (seg.source_start, seg.source_end)
        };
        out.push(TextSourceSegment {
            start: lo - u16_start,
            end: hi - u16_start,
            source_start,
            source_end,
            kind: seg.kind,
        });
    }
    out
}

fn push_inline(out: &mut Vec<Inline>, inline: Inline) {
    if let Inline::Mark {
        id,
        title,
        active,
        content,
    } = inline
    {
        if let Some(Inline::Mark {
            id: prev_id,
            title: prev_title,
            active: prev_active,
            content: prev_content,
        }) = out.last_mut()
            && *prev_id == id
            && *prev_title == title
            && *prev_active == active
        {
            prev_content.extend(content);
            return;
        }
        out.push(Inline::Mark {
            id,
            title,
            active,
            content,
        });
    } else {
        out.push(inline);
    }
}

/// If `content` collapsed to a single [`Inline::Mark`], lift the mark outside
/// `wrap` so adjacent marked spans across formatting merge into one button.
fn wrap_or_lift(content: Vec<Inline>, wrap: impl FnOnce(Vec<Inline>) -> Inline) -> Inline {
    let mut content = content;
    if content.len() == 1 && matches!(content[0], Inline::Mark { .. }) {
        let Inline::Mark {
            id,
            title,
            active,
            content: inner,
        } = content.pop().unwrap()
        else {
            unreachable!()
        };
        Inline::Mark {
            id,
            title,
            active,
            content: vec![wrap(inner)],
        }
    } else {
        wrap(content)
    }
}

fn split_leaf(
    text: String,
    segments: Option<Vec<TextSourceSegment>>,
    spans: &[(Range<usize>, usize)],
    marks: &[TextViewMark],
    out: &mut Vec<Inline>,
) {
    let piece = |range: Range<usize>| {
        let leaf = Inline::Text {
            text: text[range.clone()].to_owned(),
        };
        match &segments {
            Some(segs) => Inline::Source {
                content: vec![leaf],
                segments: slice_segments(&text, segs, range),
            },
            None => leaf,
        }
    };
    let mut cursor = 0;
    for (range, mark_idx) in spans {
        if range.start > cursor {
            push_inline(out, piece(cursor..range.start));
        }
        let mark = &marks[*mark_idx];
        push_inline(
            out,
            Inline::Mark {
                id: mark.id.to_string(),
                title: mark.title.as_ref().map(ToString::to_string),
                active: mark.active.unwrap_or(false),
                content: vec![piece(range.clone())],
            },
        );
        cursor = range.end;
    }
    if cursor < text.len() {
        push_inline(out, piece(cursor..text.len()));
    }
}

fn rewrite_inlines(
    inlines: &mut Vec<Inline>,
    next_leaf: &mut usize,
    leaf_marks: &HashMap<usize, Vec<(Range<usize>, usize)>>,
    marks: &[TextViewMark],
) {
    let mut out = Vec::with_capacity(inlines.len());
    for inline in inlines.drain(..) {
        match inline {
            Inline::Text { text } => {
                let id = *next_leaf;
                *next_leaf += 1;
                if let Some(spans) = leaf_marks.get(&id) {
                    split_leaf(text, None, spans, marks, &mut out);
                } else {
                    push_inline(&mut out, Inline::Text { text });
                }
            }
            Inline::Source {
                mut content,
                segments,
            } => {
                if content.len() == 1 && matches!(content[0], Inline::Text { .. }) {
                    let id = *next_leaf;
                    *next_leaf += 1;
                    if let Some(spans) = leaf_marks.get(&id) {
                        let Inline::Text { text } = content.pop().unwrap() else {
                            unreachable!()
                        };
                        split_leaf(text, Some(segments), spans, marks, &mut out);
                    } else {
                        push_inline(&mut out, Inline::Source { content, segments });
                    }
                } else {
                    rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                    push_inline(
                        &mut out,
                        wrap_or_lift(content, |content| Inline::Source { content, segments }),
                    );
                }
            }
            Inline::Strong { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Strong { content }),
                );
            }
            Inline::Emphasis { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Emphasis { content }),
                );
            }
            Inline::Strikethrough { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Strikethrough { content }),
                );
            }
            Inline::Underline { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Underline { content }),
                );
            }
            Inline::Highlight { mut content, color } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Highlight { content, color }),
                );
            }
            Inline::TextStyle { mut content, color } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::TextStyle { content, color }),
                );
            }
            Inline::Superscript { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Superscript { content }),
                );
            }
            Inline::Subscript { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Subscript { content }),
                );
            }
            Inline::Small { mut content } => {
                rewrite_inlines(&mut content, next_leaf, leaf_marks, marks);
                push_inline(
                    &mut out,
                    wrap_or_lift(content, |content| Inline::Small { content }),
                );
            }
            other => push_inline(&mut out, other),
        }
    }
    *inlines = out;
}

fn rewrite_blocks(
    blocks: &mut [Block],
    next_leaf: &mut usize,
    leaf_marks: &HashMap<usize, Vec<(Range<usize>, usize)>>,
    marks: &[TextViewMark],
) {
    for block in blocks {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                rewrite_inlines(content, next_leaf, leaf_marks, marks);
            }
            Block::Blockquote { children, .. } => {
                rewrite_blocks(children, next_leaf, leaf_marks, marks);
            }
            Block::List { items, .. } => {
                for item in items {
                    rewrite_blocks(&mut item.children, next_leaf, leaf_marks, marks);
                }
            }
            Block::Table(table) => {
                for row in std::iter::once(&mut table.head).chain(table.rows.iter_mut()) {
                    for cell in row {
                        rewrite_inlines(&mut cell.content, next_leaf, leaf_marks, marks);
                    }
                }
            }
            Block::Details {
                summary, children, ..
            } => {
                rewrite_inlines(summary, next_leaf, leaf_marks, marks);
                rewrite_blocks(children, next_leaf, leaf_marks, marks);
            }
            Block::CodeBlock(_) | Block::Math { .. } | Block::Rule | Block::Custom(_) => {}
        }
    }
}

/// Overlays `marks` onto `document` in place and returns the ids of marks
/// that matched at least one prose passage, in input order.
pub(super) fn apply(document: &mut Document, marks: &[TextViewMark]) -> Vec<SharedString> {
    if marks.is_empty() {
        return Vec::new();
    }
    let mut containers = Vec::new();
    let mut next_leaf = 0;
    collect_blocks(&document.blocks, &mut containers, &mut next_leaf);
    for footnote in &document.footnotes {
        collect_blocks(&footnote.children, &mut containers, &mut next_leaf);
    }
    if containers.is_empty() {
        return Vec::new();
    }

    let mut leaf_marks: HashMap<usize, Vec<(Range<usize>, usize)>> = HashMap::new();
    let mut matched = vec![false; marks.len()];

    for (mark_idx, mark) in marks.iter().enumerate() {
        for quote in &mark.quotes {
            for line in quote.split(['\n', '\t']) {
                let needle = line.trim();
                if needle.chars().count() < 2 {
                    continue;
                }
                'containers: for container in &mut containers {
                    let mut search_from = 0;
                    while let Some(rel) = container.plain[search_from..].find(needle) {
                        let start = search_from + rel;
                        let end = start + needle.len();
                        let mut hits = Vec::new();
                        let mut blocked = false;
                        for piece in &container.pieces {
                            if piece.plain_end <= start {
                                continue;
                            }
                            if piece.plain_start >= end {
                                break;
                            }
                            let Some(leaf_id) = piece.leaf_id else {
                                continue;
                            };
                            let overlap = start.max(piece.plain_start)..end.min(piece.plain_end);
                            if container.overlaps_taken(&overlap) {
                                blocked = true;
                                break;
                            }
                            let local = (overlap.start - piece.plain_start)
                                ..(overlap.end - piece.plain_start);
                            hits.push((leaf_id, overlap, local));
                        }
                        if !blocked && !hits.is_empty() {
                            for (leaf_id, overlap, local) in hits {
                                container.taken.push(overlap);
                                leaf_marks
                                    .entry(leaf_id)
                                    .or_default()
                                    .push((local, mark_idx));
                            }
                            matched[mark_idx] = true;
                            break 'containers;
                        }
                        let step = container.plain[start..]
                            .chars()
                            .next()
                            .map_or(1, char::len_utf8);
                        search_from = start + step;
                    }
                }
            }
        }
    }

    if leaf_marks.is_empty() {
        return Vec::new();
    }
    for spans in leaf_marks.values_mut() {
        spans.sort_by_key(|(range, _)| range.start);
    }

    let mut rewrite_leaf = 0;
    rewrite_blocks(&mut document.blocks, &mut rewrite_leaf, &leaf_marks, marks);
    for footnote in &mut document.footnotes {
        rewrite_blocks(
            &mut footnote.children,
            &mut rewrite_leaf,
            &leaf_marks,
            marks,
        );
    }

    marks
        .iter()
        .enumerate()
        .filter(|(i, _)| matched[*i])
        .map(|(_, mark)| mark.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_view::Parser;

    fn mark(id: &str, quotes: &[&str], active: bool) -> TextViewMark {
        TextViewMark {
            id: SharedString::from(id.to_owned()),
            title: Some(SharedString::from("Why?")),
            quotes: quotes
                .iter()
                .map(|q| SharedString::from((*q).to_owned()))
                .collect(),
            active: Some(active),
        }
    }

    fn collect_marked_texts(inlines: &[Inline], out: &mut Vec<(String, String, bool)>) {
        for inline in inlines {
            match inline {
                Inline::Mark {
                    id,
                    active,
                    content,
                    ..
                } => {
                    let mut text = String::new();
                    inline_text(content, &mut text);
                    out.push((id.clone(), text, *active));
                }
                Inline::Source { content, .. }
                | Inline::Strong { content }
                | Inline::Emphasis { content }
                | Inline::Strikethrough { content }
                | Inline::Underline { content }
                | Inline::Highlight { content, .. }
                | Inline::TextStyle { content, .. }
                | Inline::Superscript { content }
                | Inline::Subscript { content }
                | Inline::Small { content }
                | Inline::Link { content, .. } => collect_marked_texts(content, out),
                _ => {}
            }
        }
    }

    fn all_marked(doc: &Document) -> Vec<(String, String, bool)> {
        fn walk(blocks: &[Block], out: &mut Vec<(String, String, bool)>) {
            for block in blocks {
                match block {
                    Block::Paragraph { content } | Block::Heading { content, .. } => {
                        collect_marked_texts(content, out);
                    }
                    Block::Blockquote { children, .. } => walk(children, out),
                    Block::List { items, .. } => {
                        for item in items {
                            walk(&item.children, out);
                        }
                    }
                    Block::Table(table) => {
                        for row in std::iter::once(&table.head).chain(table.rows.iter()) {
                            for cell in row {
                                collect_marked_texts(&cell.content, out);
                            }
                        }
                    }
                    Block::Details {
                        summary, children, ..
                    } => {
                        collect_marked_texts(summary, out);
                        walk(children, out);
                    }
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(&doc.blocks, &mut out);
        out
    }

    #[test]
    fn marks_prose_across_formatting_and_preserves_underscores() {
        let mut doc = Parser::new().markdown("Call **update** on side_question_id now.");
        let ids = apply(
            &mut doc,
            &[mark("s1", &["update on side_question_id"], true)],
        );
        assert_eq!(ids, vec![SharedString::from("s1")]);
        assert_eq!(doc.plain_text(), "Call update on side_question_id now.");
        assert_eq!(
            all_marked(&doc),
            vec![("s1".into(), "update on side_question_id".into(), true)]
        );
    }

    #[test]
    fn skips_code_blocks_even_with_unmatched_backticks_and_marks_following_prose() {
        let md = "```js\n// don't use `eval\n```\n\nImportant cache invalidation note with `ttl`.";
        let mut doc = Parser::new().markdown(md);
        let ids = apply(
            &mut doc,
            &[
                mark("code", &["don't use"], false),
                mark("prose", &["Important cache invalidation note"], false),
            ],
        );
        assert_eq!(ids, vec![SharedString::from("prose")]);
        assert_eq!(
            all_marked(&doc),
            vec![(
                "prose".into(),
                "Important cache invalidation note".into(),
                false
            )]
        );
    }

    #[test]
    fn skips_inline_code_and_links_while_matching_surrounding_prose() {
        let mut doc = Parser::new().markdown(
            "Set **mode** to `side_questions` here. See [the docs](https://example.com) for details.",
        );
        let ids = apply(
            &mut doc,
            &[
                mark("code_only", &["side_questions"], false),
                mark("span_code", &["mode to side_questions here"], false),
                mark("span_link", &["the docs for details"], false),
            ],
        );
        assert_eq!(
            ids,
            vec![
                SharedString::from("span_code"),
                SharedString::from("span_link")
            ]
        );
        assert_eq!(
            all_marked(&doc),
            vec![
                ("span_code".into(), "mode to ".into(), false),
                ("span_code".into(), " here".into(), false),
                ("span_link".into(), " for details".into(), false),
            ]
        );
    }

    #[test]
    fn marks_table_cells_without_breaking_table_structure() {
        let md = "| Col A | Col B |\n| --- | --- |\n| cache key | stale value |";
        let mut doc = Parser::new().markdown(md);
        let ids = apply(&mut doc, &[mark("s1", &["cache key\tstale value"], true)]);
        assert_eq!(ids, vec![SharedString::from("s1")]);
        assert!(matches!(doc.blocks.as_slice(), [Block::Table(_)]));
        assert_eq!(
            all_marked(&doc),
            vec![
                ("s1".into(), "cache key".into(), true),
                ("s1".into(), "stale value".into(), true),
            ]
        );
    }

    #[test]
    fn marks_cjk_and_keeps_after_byte_custom_anchors_intact() {
        use crate::text_view::MarkdownExtension;
        let md = "缓存会先失效再更新。";
        let ext = MarkdownExtension {
            name: SharedString::from("cite-1"),
            after_byte: Some("缓存会先失效".len() as u32),
            ..MarkdownExtension::default()
        };
        let mut doc = Parser::new().extensions(vec![ext]).markdown(md);
        let ids = apply(&mut doc, &[mark("s1", &["先失效再更新"], false)]);
        assert_eq!(ids, vec![SharedString::from("s1")]);
        assert_eq!(
            all_marked(&doc),
            vec![
                ("s1".into(), "先失效".into(), false),
                ("s1".into(), "再更新".into(), false),
            ]
        );
    }
}
