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

//! Markdown as a flat list of blocks, each holding the text it renders.
//! Lists and quotes flatten into their paragraphs with a depth, so every
//! block is one run of text (a table is one run per cell), which is what
//! layout, the fade and selection all work on.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Paragraph,
    Heading(u8),
    Item(Marker),
    Code { language: Option<String> },
    Rule,
    Table { columns: usize },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Marker {
    Bullet,
    Number(u64),
    Task(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Strong,
    Emphasis,
    Strike,
    Code,
    Link,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Text {
    pub text: String,
    /// Sorted by start; ranges may nest (a link inside strong text).
    pub styles: Vec<(Range<usize>, Style)>,
    pub links: Vec<(Range<usize>, String)>,
    /// `(text offset, source offset)` where each source piece begins, so a
    /// byte of text can be traced back to when its source arrived.
    pub origins: Vec<(usize, usize)>,
}

#[cfg(test)]
impl Text {
    fn source_of(&self, offset: usize) -> usize {
        let at = self.origins.partition_point(|(text, _)| *text <= offset);
        match at.checked_sub(1) {
            Some(ix) => self.origins[ix].1 + (offset - self.origins[ix].0),
            None => self.origins.first().map_or(0, |(_, source)| *source),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub kind: Kind,
    /// List nesting; an item's continuation paragraphs share its depth.
    pub depth: u8,
    pub quote: u8,
    /// One text for most blocks; a table holds its cells row by row, the
    /// first row being the header.
    pub texts: Vec<Text>,
    /// Which top-level markdown block this came from.
    top: usize,
}

pub struct Parsed {
    pub blocks: Vec<Block>,
    /// Source offset where each top-level block begins.
    pub tops: Vec<usize>,
    pub has_definitions: bool,
}

pub fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Parses `source`, reporting source offsets as if it began at `base`.
pub fn parse(source: &str, base: usize) -> Parsed {
    let mut builder = Builder {
        base,
        ..Builder::default()
    };
    let mut events = Parser::new_ext(source, options()).into_offset_iter();
    for (event, range) in events.by_ref() {
        builder.event(event, range);
    }
    let has_definitions = events.reference_definitions().iter().next().is_some();
    builder.close();
    Parsed {
        blocks: builder.blocks,
        tops: builder.tops,
        has_definitions,
    }
}

#[derive(Default)]
struct Builder {
    base: usize,
    blocks: Vec<Block>,
    tops: Vec<usize>,
    nesting: usize,
    open: Option<Block>,
    styles: Vec<(usize, Style)>,
    links: Vec<(usize, String)>,
    lists: Vec<Option<u64>>,
    marker: Option<Marker>,
    quote: u8,
    heading: Option<u8>,
    in_code: bool,
}

impl Builder {
    fn event(&mut self, event: Event, range: Range<usize>) {
        let source = self.base + range.start;
        match event {
            Event::Start(tag) => {
                if self.nesting == 0 {
                    self.tops.push(source);
                }
                self.nesting += 1;
                self.start(tag, source);
            }
            Event::End(tag) => {
                self.nesting -= 1;
                self.end(tag);
            }
            Event::Text(text) => self.push(&text, source, None),
            Event::Code(text) => {
                let ticks = range.len().saturating_sub(text.len()) / 2;
                self.push(&text, source + ticks, Some(Style::Code));
            }
            Event::Html(text) | Event::InlineHtml(text) => self.push(&text, source, None),
            // Chat text means its single newlines.
            Event::SoftBreak | Event::HardBreak => self.push("\n", source, None),
            Event::TaskListMarker(done) => match &mut self.open {
                // A loose item opens its paragraph before the checkbox arrives.
                Some(Block {
                    kind: Kind::Item(marker),
                    ..
                }) => *marker = Marker::Task(done),
                _ => self.marker = Some(Marker::Task(done)),
            },
            Event::Rule => {
                if self.nesting == 0 {
                    self.tops.push(source);
                }
                self.close_text();
                self.emit(Kind::Rule);
            }
            Event::FootnoteReference(label) => self.push(&format!("[{label}]"), source, None),
            Event::InlineMath(text) | Event::DisplayMath(text) => {
                self.push(&text, source, Some(Style::Code))
            }
        }
    }

    fn start(&mut self, tag: Tag, source: usize) {
        match tag {
            Tag::Paragraph | Tag::HtmlBlock => self.open_text(source),
            Tag::Heading { level, .. } => {
                self.close_text();
                self.flush_marker();
                self.heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
                self.open_text(source);
            }
            Tag::BlockQuote(_) => {
                self.close_text();
                self.flush_marker();
                self.quote += 1;
            }
            Tag::CodeBlock(kind) => {
                self.close_text();
                self.flush_marker();
                let language = match kind {
                    CodeBlockKind::Fenced(info) => info
                        .split_whitespace()
                        .next()
                        .filter(|language| !language.is_empty())
                        .map(str::to_owned),
                    CodeBlockKind::Indented => None,
                };
                self.in_code = true;
                self.open = Some(self.block(Kind::Code { language }, vec![Text::default()]));
            }
            Tag::List(start) => {
                self.close_text();
                self.flush_marker();
                self.lists.push(start);
            }
            Tag::Item => {
                self.close_text();
                let marker = match self.lists.last_mut() {
                    Some(Some(number)) => {
                        *number += 1;
                        Marker::Number(*number - 1)
                    }
                    _ => Marker::Bullet,
                };
                self.marker = Some(marker);
            }
            Tag::Table(alignments) => {
                self.close_text();
                self.flush_marker();
                self.open = Some(self.block(
                    Kind::Table {
                        columns: alignments.len(),
                    },
                    Vec::new(),
                ));
            }
            Tag::TableCell => {
                if let Some(table) = &mut self.open {
                    table.texts.push(Text::default());
                }
            }
            Tag::Emphasis => self.style(Style::Emphasis),
            Tag::Strong => self.style(Style::Strong),
            Tag::Strikethrough => self.style(Style::Strike),
            Tag::Link { dest_url, .. } => {
                self.open_text(source);
                self.style(Style::Link);
                let at = self.len();
                self.links.push((at, dest_url.into_string()));
            }
            Tag::Image { .. } => self.open_text(source),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::HtmlBlock => self.close_text(),
            TagEnd::Heading(_) => {
                self.close_text();
                self.heading = None;
            }
            TagEnd::BlockQuote(_) => {
                self.close_text();
                self.quote = self.quote.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                self.in_code = false;
                if let Some(mut block) = self.open.take() {
                    if let Some(text) = block.texts.first_mut()
                        && text.text.ends_with('\n')
                    {
                        text.text.pop();
                    }
                    self.blocks.push(block);
                }
            }
            TagEnd::List(_) => {
                self.close_text();
                self.lists.pop();
            }
            TagEnd::Item => {
                self.close_text();
                self.flush_marker();
            }
            TagEnd::Table => {
                if let Some(block) = self.open.take() {
                    self.blocks.push(block);
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => self.unstyle(),
            TagEnd::Link => {
                self.unstyle();
                if let Some((start, url)) = self.links.pop() {
                    let end = self.len();
                    if let Some(text) = self.current() {
                        text.links.push((start..end, url));
                    }
                }
            }
            _ => {}
        }
    }

    fn block(&self, kind: Kind, texts: Vec<Text>) -> Block {
        Block {
            kind,
            depth: self.lists.len() as u8,
            quote: self.quote,
            texts,
            top: self.tops.len().saturating_sub(1),
        }
    }

    fn emit(&mut self, kind: Kind) {
        let block = self.block(kind, vec![Text::default()]);
        self.blocks.push(block);
    }

    /// An item whose first block is not text still shows its marker, on a
    /// row of its own above that block.
    fn flush_marker(&mut self) {
        if let Some(marker) = self.marker.take() {
            self.emit(Kind::Item(marker));
        }
    }

    fn open_text(&mut self, _source: usize) {
        if self.open.is_some() {
            return;
        }
        let kind = match (self.heading, self.marker.take()) {
            (Some(level), _) => Kind::Heading(level),
            (None, Some(marker)) => Kind::Item(marker),
            (None, None) => Kind::Paragraph,
        };
        self.open = Some(self.block(kind, vec![Text::default()]));
    }

    fn close_text(&mut self) {
        if self.in_code {
            return;
        }
        if let Some(block) = &self.open
            && matches!(block.kind, Kind::Table { .. })
        {
            return;
        }
        if let Some(block) = self.open.take() {
            self.blocks.push(block);
        }
        self.styles.clear();
    }

    fn current(&mut self) -> Option<&mut Text> {
        self.open.as_mut()?.texts.last_mut()
    }

    fn len(&mut self) -> usize {
        self.current().map_or(0, |text| text.text.len())
    }

    fn style(&mut self, style: Style) {
        let at = self.len();
        self.styles.push((at, style));
    }

    fn unstyle(&mut self) {
        if let Some((start, style)) = self.styles.pop() {
            let end = self.len();
            if let Some(text) = self.current()
                && start < end
            {
                text.styles.push((start..end, style));
            }
        }
    }

    fn push(&mut self, piece: &str, source: usize, style: Option<Style>) {
        if piece.is_empty() {
            return;
        }
        if self.open.is_none() {
            self.open_text(source);
        }
        let Some(text) = self.current() else {
            return;
        };
        let start = text.text.len();
        text.origins.push((start, source));
        text.text.push_str(piece);
        if let Some(style) = style {
            text.styles.push((start..text.text.len(), style));
        }
    }

    fn close(&mut self) {
        self.in_code = false;
        if let Some(block) = self.open.take() {
            self.blocks.push(block);
        }
        for block in &mut self.blocks {
            for text in &mut block.texts {
                text.styles.sort_by_key(|(range, _)| range.start);
            }
        }
    }
}

/// A markdown document that grows as a reply streams in. Blocks before the
/// last two top-level blocks are kept; each update reparses only from there,
/// because a new line can still reshape the block before it (a table's
/// delimiter row, a setext underline).
#[derive(Default)]
pub struct Document {
    source: String,
    streaming: bool,
    settled: Vec<Block>,
    settled_end: usize,
    tail: Vec<Block>,
    /// A link definition can change any earlier link, so nothing settles.
    whole: bool,
}

impl Document {
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn blocks(&self) -> impl Iterator<Item = &Block> {
        self.settled.iter().chain(&self.tail)
    }

    /// Replaces the source. While `streaming`, the unfinished end is mended
    /// so half-typed markers do not show.
    pub fn update(&mut self, source: &str, streaming: bool) {
        if self.source == source && self.streaming == streaming && !source.is_empty() {
            return;
        }
        if !source.starts_with(&self.source[..self.settled_end]) {
            self.restart();
        }
        self.source.clear();
        self.source.push_str(source);
        self.streaming = streaming;
        let mut parsed = self.parse_tail();
        if parsed.has_definitions && self.settled_end > 0 {
            self.restart();
            parsed = self.parse_tail();
        }
        self.whole |= parsed.has_definitions;
        let mut blocks = parsed.blocks;
        if !self.whole && parsed.tops.len() > 2 {
            let keep = parsed.tops.len() - 2;
            let split = blocks.partition_point(|block| block.top < keep);
            self.settled.extend(blocks.drain(..split));
            self.settled_end = parsed.tops[keep];
        }
        self.tail = blocks;
    }

    fn restart(&mut self) {
        self.settled.clear();
        self.settled_end = 0;
        self.whole = false;
    }

    fn parse_tail(&self) -> Parsed {
        let tail = &self.source[self.settled_end..];
        if self.streaming {
            parse(&super::mend::mend(tail), self.settled_end)
        } else {
            parse(tail, self.settled_end)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(blocks: &[Block]) -> Vec<(Kind, Vec<String>)> {
        blocks
            .iter()
            .map(|block| {
                (
                    block.kind.clone(),
                    block.texts.iter().map(|text| text.text.clone()).collect(),
                )
            })
            .collect()
    }

    const CORPUS: &str = "# Title\n\nIntro with **bold** and `code` and a [link](https://x.y).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n> text\n\n```rust\nfn main() {}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nSetext\n===\n\nDone ~~now~~.\n";

    #[test]
    fn single_newlines_stay_line_breaks() {
        let parsed = parse("Name: a\nPath: b", 0);
        assert_eq!(parsed.blocks[0].texts[0].text, "Name: a\nPath: b");
    }

    #[test]
    fn an_item_keeps_its_marker_above_a_leading_block() {
        let blocks = texts(&parse("1. ```sh\n   ls\n   ```\n2. next\n", 0).blocks);
        assert_eq!(
            blocks,
            vec![
                (Kind::Item(Marker::Number(1)), vec![String::new()]),
                (
                    Kind::Code {
                        language: Some("sh".into())
                    },
                    vec!["ls".into()]
                ),
                (Kind::Item(Marker::Number(2)), vec!["next".into()]),
            ]
        );
        let loose = texts(&parse("- [x] done\n\n- [ ] todo\n", 0).blocks);
        assert_eq!(
            loose,
            vec![
                (Kind::Item(Marker::Task(true)), vec!["done".into()]),
                (Kind::Item(Marker::Task(false)), vec!["todo".into()]),
            ]
        );
    }

    #[test]
    fn flattens_lists_quotes_tables_and_code() {
        let parsed = parse(CORPUS, 0);
        let blocks = texts(&parsed.blocks);
        assert_eq!(blocks[0], (Kind::Heading(1), vec!["Title".into()]));
        assert_eq!(
            blocks[1].1,
            vec!["Intro with bold and code and a link.".to_string()]
        );
        assert_eq!(blocks[2], (Kind::Item(Marker::Bullet), vec!["one".into()]));
        assert_eq!(parsed.blocks[4].depth, 2);
        assert_eq!(
            blocks[5],
            (Kind::Item(Marker::Number(1)), vec!["first".into()])
        );
        assert_eq!(
            blocks[6],
            (Kind::Item(Marker::Number(2)), vec!["second".into()])
        );
        assert_eq!(parsed.blocks[7].quote, 1);
        assert_eq!(blocks[7].1, vec!["quoted\ntext".to_string()]);
        assert_eq!(
            blocks[8],
            (
                Kind::Code {
                    language: Some("rust".into())
                },
                vec!["fn main() {}".into()]
            )
        );
        assert_eq!(
            blocks[9],
            (
                Kind::Table { columns: 2 },
                vec!["a".into(), "b".into(), "1".into(), "2".into()]
            )
        );
        assert_eq!(blocks[10].0, Kind::Rule);
        assert_eq!(blocks[11], (Kind::Heading(1), vec!["Setext".into()]));
    }

    #[test]
    fn styles_and_origins_point_back_into_the_source() {
        let source = "Intro with **bold** and `code`.";
        let parsed = parse(source, 0);
        let text = &parsed.blocks[0].texts[0];
        let bold = text.text.find("bold").unwrap();
        assert!(text.styles.contains(&(bold..bold + 4, Style::Strong)));
        assert_eq!(&source[text.source_of(bold)..][..4], "bold");
        let code = text.text.find("code").unwrap();
        assert_eq!(&source[text.source_of(code)..][..4], "code");
    }

    #[test]
    fn streaming_every_prefix_ends_like_a_full_parse() {
        let mut document = Document::default();
        for end in (1..=CORPUS.len()).filter(|end| CORPUS.is_char_boundary(*end)) {
            document.update(&CORPUS[..end], true);
        }
        document.update(CORPUS, false);
        let streamed: Vec<_> = document.blocks().cloned().collect();
        assert_eq!(texts(&streamed), texts(&parse(CORPUS, 0).blocks));
    }

    #[test]
    fn a_rewrite_before_the_settled_part_starts_over() {
        let mut document = Document::default();
        document.update("a\n\nb\n\nc\n\nd\n", false);
        document.update("x\n\ny\n", false);
        let blocks: Vec<_> = document.blocks().cloned().collect();
        assert_eq!(
            texts(&blocks),
            vec![
                (Kind::Paragraph, vec!["x".into()]),
                (Kind::Paragraph, vec!["y".into()])
            ]
        );
    }

    #[test]
    fn a_link_definition_keeps_the_whole_document_open() {
        let mut document = Document::default();
        let source = "see [x][r]\n\na\n\nb\n\nc\n\n[r]: https://r.example\n";
        for end in 1..=source.len() {
            document.update(&source[..end], true);
        }
        document.update(source, false);
        let first = document.blocks().next().unwrap();
        assert_eq!(first.texts[0].links[0].1, "https://r.example");
    }
}
