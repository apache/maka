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

//! Terminal-safe layout with source ranges; generated decoration has no source range.
pub mod diff;
mod fenced;
pub mod syntax;
mod table;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const MAX_LINES: usize = 131_072;
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct VisualLine {
    pub line: Line<'static>,
    pub source: usize,
    pub mapping: Vec<SourceSpan>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SourceSpan {
    /// UTF-8 bytes in the rendered line, before message gutters/timestamps.
    pub display: Range<usize>,
    pub source: Range<usize>,
    /// Stable byte offsets in layout.text, independent of wrapping and table presentation.
    pub logical: Range<usize>,
    pub exact: bool,
}
impl SourceSpan {
    pub fn intersection(&self, source: &Range<usize>) -> Option<Range<usize>> {
        let start = source.start.max(self.source.start);
        let end = source.end.min(self.source.end);
        (start < end).then(|| {
            if self.exact {
                self.display.start + start - self.source.start
                    ..self.display.start + end - self.source.start
            } else {
                self.display.clone()
            }
        })
    }
}
pub struct Layout {
    pub lines: Vec<VisualLine>,
    pub bytes: usize,
    pub text: String,
}

struct Writer {
    colors: crate::theme::Palette,
    width: usize,
    lines: Vec<VisualLine>,
    line: Line<'static>,
    cells: usize,
    source: Option<usize>,
    bytes: usize,
    style: Style,
    indent: usize,
    display: usize,
    mapping: Vec<SourceSpan>,
    text: String,
    /// The line ends in a break opportunity (a space or a wide grapheme).
    word_break: bool,
}
impl Writer {
    fn new(width: u16) -> Self {
        Self {
            colors: crate::theme::Palette::default(),
            width: usize::from(width.max(1)),
            lines: vec![],
            line: Line::default(),
            cells: 0,
            source: None,
            bytes: 0,
            style: Style::default(),
            indent: 0,
            display: 0,
            mapping: vec![],
            text: String::new(),
            word_break: false,
        }
    }
    fn flush(&mut self) -> Result<(), &'static str> {
        if self.lines.len() >= MAX_LINES || self.bytes > MAX_BYTES {
            return Err("Transcript layout exceeds local capacity");
        }
        self.bytes += std::mem::size_of::<VisualLine>();
        let previous = self.lines.last().map_or(0, |line| line.source);
        self.lines.push(VisualLine {
            line: std::mem::take(&mut self.line),
            source: self.source.take().unwrap_or(previous),
            mapping: std::mem::take(&mut self.mapping),
        });
        self.cells = 0;
        self.display = 0;
        self.word_break = false;
        Ok(())
    }
    fn boundary(&mut self) -> Result<(), &'static str> {
        if !self.line.spans.is_empty() {
            self.flush()?;
            self.logical("\n");
        }
        Ok(())
    }
    fn gap(&mut self) -> Result<(), &'static str> {
        self.boundary()?;
        if self
            .lines
            .last()
            .is_some_and(|line| !line.line.spans.is_empty())
        {
            self.flush()?;
            self.logical("\n");
        }
        Ok(())
    }
    fn span(&mut self, text: &str) {
        self.bytes += text.len();
        self.display += text.len();
        if let Some(last) = self
            .line
            .spans
            .last_mut()
            .filter(|last| last.style == self.style)
        {
            last.content.to_mut().push_str(text);
        } else {
            self.bytes += std::mem::size_of::<Span<'static>>();
            self.line
                .spans
                .push(Span::styled(text.to_owned(), self.style));
        }
    }
    fn logical(&mut self, text: &str) {
        self.bytes += text.len();
        self.text.push_str(text);
    }
    fn mapped_span(
        &mut self,
        text: &str,
        source: Range<usize>,
        exact: bool,
        logical: Range<usize>,
    ) {
        let start = self.display;
        self.span(text);
        if logical.is_empty() || text.is_empty() {
            return;
        }
        if let Some(last) = self.mapping.last_mut()
            && last.display.end == start
            && last.logical.end == logical.start
            && last.display.len() == last.logical.len()
            && text.len() == logical.len()
            && ((last.exact && exact && last.source.end == source.start)
                || (!last.exact && !exact && last.source == source))
        {
            last.source.end = source.end;
            last.display.end = self.display;
            last.logical.end = logical.end;
        } else {
            self.bytes += std::mem::size_of::<SourceSpan>();
            self.mapping.push(SourceSpan {
                display: start..self.display,
                source,
                logical,
                exact,
            });
        }
    }
    fn decoration(&mut self, text: &str, anchor: usize) -> Result<(), &'static str> {
        self.write(text, anchor..anchor, false, false)
    }
    fn text(&mut self, text: &str, source: Range<usize>, exact: bool) -> Result<(), &'static str> {
        self.write(text, source, exact, true)
    }
    fn write(
        &mut self,
        text: &str,
        source: Range<usize>,
        exact: bool,
        semantic: bool,
    ) -> Result<(), &'static str> {
        for (offset, grapheme) in text.grapheme_indices(true) {
            if self.bytes > MAX_BYTES {
                return Err("Transcript layout exceeds local capacity");
            }
            let position = if exact {
                source.start + offset
            } else {
                source.start
            };
            if grapheme == "\n" || grapheme == "\r\n" {
                self.source.get_or_insert(position);
                if semantic {
                    self.logical("\n");
                }
                self.flush()?;
                continue;
            }
            let safe = if grapheme == "\t" {
                " ".repeat(4 - self.cells % 4)
            } else {
                crate::view::safe(grapheme)
            };
            let width = safe.width();
            let space = matches!(grapheme, " " | "\t");
            if semantic && space && self.cells + width > self.width && self.cells > 0 {
                // A space that ends a visual line is kept in copied text but
                // never carried over as indentation of the next line.
                self.flush()?;
                self.logical(grapheme);
                continue;
            }
            if semantic && self.word_break && !space && width == 1 {
                // Start an overflowing word on a fresh line; words longer than a
                // line then break between graphemes there, like wide (CJK) text.
                let word: usize = text[offset..]
                    .graphemes(true)
                    .map(|grapheme| crate::view::safe(grapheme).width())
                    .zip(text[offset..].graphemes(true))
                    .take_while(|(width, grapheme)| {
                        *width == 1 && !matches!(*grapheme, " " | "\t" | "\n" | "\r" | "\r\n")
                    })
                    .map(|(width, _)| width)
                    .sum();
                if self.cells + word > self.width {
                    self.flush()?;
                }
            }
            if self.cells + width > self.width && self.cells > 0 {
                self.flush()?;
            }
            if self.line.spans.is_empty() && self.indent > 0 {
                let indent = self.indent.min(self.width.saturating_sub(width.max(1)));
                self.span(&" ".repeat(indent));
                self.cells = indent;
            }
            self.source.get_or_insert(position);
            let logical = self.text.len();
            if semantic {
                self.logical(if grapheme == "\t" { "\t" } else { &safe });
            }
            let logical = logical..self.text.len();
            let mapped = if exact {
                position..position + grapheme.len()
            } else {
                source.clone()
            };
            if width > self.width {
                self.mapped_span("?", mapped, false, logical); // A two-cell grapheme cannot fit here.
                self.cells += 1;
            } else {
                self.mapped_span(&safe, mapped, exact && safe == grapheme, logical);
                self.cells += width;
            }
            self.word_break = semantic && (space || width > 1);
        }
        Ok(())
    }
    fn finish(mut self, trim: bool) -> Result<Layout, &'static str> {
        self.boundary()?;
        while trim
            && self
                .lines
                .last()
                .is_some_and(|line| line.line.spans.is_empty())
        {
            self.lines.pop();
        }
        if self.lines.is_empty() {
            self.flush()?;
        }
        if trim {
            self.text.truncate(self.text.trim_end_matches('\n').len());
        }
        Ok(Layout {
            lines: self.lines,
            bytes: self.bytes,
            text: self.text,
        })
    }
}

pub fn plain(text: &str, width: u16) -> Result<Layout, &'static str> {
    let mut writer = Writer::new(width);
    writer.text(text, 0..text.len(), true)?;
    writer.finish(true)
}

pub fn markdown(text: &str, width: u16, ascii: bool) -> Result<Layout, &'static str> {
    markdown_part(text, width, ascii, true, &mut syntax::Cache::default())
}
pub(super) fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS
}
pub(super) fn markdown_part(
    text: &str,
    width: u16,
    ascii: bool,
    trim: bool,
    code: &mut syntax::Cache,
) -> Result<Layout, &'static str> {
    let mut events = Parser::new_ext(text, options()).into_offset_iter();
    let mut destinations = Vec::new();
    let events = std::iter::from_fn(move || {
        let (event, mut range) = events.next()?;
        match &event {
            Event::Start(Tag::Link { id, .. } | Tag::Image { id, .. }) => {
                destinations.push(
                    events
                        .reference_definitions()
                        .get(id)
                        .map_or_else(|| range.clone(), |definition| definition.span.clone()),
                );
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some(destination) = destinations.pop() {
                    range = destination;
                }
            }
            _ => {}
        }
        Some((event, range))
    });
    render_events(text, events, width, ascii, trim, code)
}

fn render_events<'a>(
    text: &str,
    events: impl IntoIterator<Item = (Event<'a>, Range<usize>)>,
    width: u16,
    ascii: bool,
    trim: bool,
    code_cache: &mut syntax::Cache,
) -> Result<Layout, &'static str> {
    let mut writer = Writer::new(width);
    writer.colors = code_cache.colors;
    let mut styles = Vec::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut links = Vec::new();
    let mut events = events.into_iter();
    while let Some((event, range)) = events.next() {
        if let Event::Start(Tag::CodeBlock(kind)) = event {
            fenced::render(
                &mut writer,
                text,
                kind,
                range.start,
                &mut events,
                code_cache,
                ascii,
            )?;
            continue;
        }
        if let Event::Start(Tag::Table(alignments)) = event {
            table::render(&mut writer, text, alignments, &mut events, ascii)?;
            continue;
        }
        match event {
            Event::Start(tag) => {
                styles.push(writer.style);
                match tag {
                    Tag::Heading { level, .. } => {
                        writer.boundary()?;
                        writer.style = heading(writer.style, level, writer.colors);
                    }
                    Tag::HtmlBlock => writer.boundary()?,
                    Tag::Emphasis => writer.style = writer.style.add_modifier(Modifier::ITALIC),
                    Tag::Strong => writer.style = writer.style.add_modifier(Modifier::BOLD),
                    Tag::Strikethrough => {
                        writer.style = writer.style.add_modifier(Modifier::CROSSED_OUT)
                    }
                    Tag::BlockQuote(_) => {
                        writer.boundary()?;
                        writer.style = writer.style.fg(writer.colors.subtle);
                        writer.decoration(if ascii { "> " } else { "│ " }, range.start)?;
                    }
                    Tag::List(start) => {
                        writer.boundary()?;
                        lists.push(start);
                    }
                    Tag::Item => {
                        writer.boundary()?;
                        writer.indent = lists.len().saturating_sub(1).min(16) * 2;
                        let marker = match lists.last_mut() {
                            Some(Some(number)) => {
                                let marker = format!("{number}. ");
                                *number = number.saturating_add(1);
                                marker
                            }
                            _ => if ascii { "- " } else { "• " }.into(),
                        };
                        let style = writer.style;
                        writer.style = style.fg(writer.colors.subtle);
                        writer.decoration(&marker, range.start)?;
                        writer.style = style;
                        writer.indent = lists.len().min(16) * 2;
                    }
                    Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
                        links.push(dest_url);
                        writer.style = writer
                            .style
                            .fg(writer.colors.accent)
                            .add_modifier(Modifier::UNDERLINED);
                    }
                    _ => {}
                }
            }
            Event::End(tag) => {
                writer.style = styles.pop().unwrap_or_default();
                match tag {
                    TagEnd::Paragraph
                    | TagEnd::Heading(_)
                    | TagEnd::CodeBlock
                    | TagEnd::HtmlBlock
                    | TagEnd::BlockQuote(_) => writer.gap()?,
                    TagEnd::Item => writer.boundary()?,
                    TagEnd::List(_) => {
                        lists.pop();
                        writer.indent = lists.len().min(16) * 2;
                        if lists.is_empty() {
                            writer.gap()?;
                        }
                    }
                    TagEnd::Link | TagEnd::Image => {
                        if let Some(url) = links.pop() {
                            let style = writer.style;
                            writer.style = writer.style.fg(writer.colors.subtle);
                            let start = text
                                .get(range.clone())
                                .and_then(|text| text.find(url.as_ref()))
                                .map_or(range.end, |offset| range.start + offset);
                            writer.text(" (", start..start, false)?;
                            if start < range.end {
                                mapped(&mut writer, text, &url, start..range.end)?;
                            } else {
                                writer.text(&url, start..start, false)?;
                            }
                            writer.text(")", range.end..range.end, false)?;
                            writer.style = style;
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(value) | Event::Html(value) | Event::InlineHtml(value) => {
                mapped(&mut writer, text, &value, range)?;
            }
            Event::Code(value) => {
                let style = writer.style;
                writer.style = style.fg(writer.colors.warning);
                code(&mut writer, text, &value, range)?;
                writer.style = style;
            }
            Event::InlineMath(value) | Event::DisplayMath(value) => {
                let style = writer.style;
                writer.style = style.fg(writer.colors.warning);
                mapped(&mut writer, text, &value, range)?;
                writer.style = style;
            }
            Event::SoftBreak => writer.text(" ", range, false)?,
            Event::HardBreak => {
                writer.logical("\n");
                writer.flush()?;
            }
            Event::Rule => {
                writer.boundary()?;
                let style = writer.style;
                writer.style = style.fg(writer.colors.subtle);
                writer.decoration(if ascii { "---" } else { "───" }, range.start)?;
                writer.style = style;
                writer.gap()?;
            }
            Event::TaskListMarker(done) => {
                writer.text(if done { "[x] " } else { "[ ] " }, range, false)?
            }
            Event::FootnoteReference(value) => writer.text(&value, range, false)?,
        }
    }
    writer.finish(trim)
}

/// Top-level headings take distinct accents; deeper levels recede to text grays.
fn heading(style: Style, level: HeadingLevel, colors: crate::theme::Palette) -> Style {
    let color = match level {
        HeadingLevel::H1 => colors.syntax[5],
        HeadingLevel::H2 => colors.accent,
        HeadingLevel::H3 => colors.syntax[0],
        HeadingLevel::H4 | HeadingLevel::H5 => colors.muted,
        HeadingLevel::H6 => return style.fg(colors.subtle),
    };
    style.fg(color).add_modifier(Modifier::BOLD)
}

fn mapped(
    writer: &mut Writer,
    source: &str,
    value: &str,
    range: Range<usize>,
) -> Result<(), &'static str> {
    // Inline code ranges include delimiters. Preserve positions within long wrapped code/URLs,
    // rather than assigning every visual row the start of the entire Markdown event.
    let original = source.get(range.clone()).unwrap_or("");
    if original.starts_with('&') && original.ends_with(';') && original != value {
        return writer.text(value, range, false);
    }
    if let Some(offset) = original.find(value) {
        let start = range.start + offset;
        writer.text(value, start..start + value.len(), true)
    } else {
        // A decoded token maps to its source token, never to neighboring decoration.
        writer.text(value, range, false)
    }
}

fn code(
    writer: &mut Writer,
    source: &str,
    value: &str,
    range: Range<usize>,
) -> Result<(), &'static str> {
    let raw = source.get(range.clone()).unwrap_or("");
    let ticks = raw.bytes().take_while(|byte| *byte == b'`').count();
    if ticks == 0 || ticks * 2 > raw.len() || !raw.ends_with(&raw[..ticks]) {
        return mapped(writer, source, value, range);
    }
    let body = &raw[ticks..raw.len() - ticks];
    let normalized = body.replace("\r\n", " ").replace(['\r', '\n'], " ");
    let trim = normalized.starts_with(' ')
        && normalized.ends_with(' ')
        && !normalized.trim_matches(' ').is_empty();
    let expected = if trim {
        &normalized[1..normalized.len() - 1]
    } else {
        &normalized
    };
    if expected != value {
        return writer.text(value, range, false);
    }
    let first = if trim {
        body.graphemes(true).next().map_or(0, str::len)
    } else {
        0
    };
    let last = if trim {
        body.graphemes(true).next_back().map_or(0, str::len)
    } else {
        0
    };
    for (offset, grapheme) in body[first..body.len() - last].grapheme_indices(true) {
        let start = range.start + ticks + first + offset;
        let newline = matches!(grapheme, "\n" | "\r" | "\r\n");
        writer.text(
            if newline { " " } else { grapheme },
            start..start + grapheme.len(),
            !newline,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn words_wrap_whole_while_long_words_and_wide_text_still_break() {
        let text =
            "- **Vast** about 93 billion light-years across\n\n中文中文中文 supercalifragilistic";
        let layout = markdown(text, 16, false).unwrap();
        let rows: Vec<String> = layout
            .lines
            .iter()
            .map(|line| line.line.to_string().trim_end().to_owned())
            .collect();
        assert_eq!(rows[0], "• Vast about 93");
        assert_eq!(
            rows[1], "  billion",
            "continuations keep list indent, not a carried space"
        );
        assert_eq!(rows[2], "  light-years");
        assert_eq!(rows[3], "  across");
        assert!(rows.iter().all(|row| row.width() <= 16));
        // Wide text breaks between graphemes; a word longer than the line still splits.
        assert_eq!(rows[5], "中文中文中文");
        assert_eq!(rows[6], "supercalifragili");
        assert_eq!(rows[7], "stic");
        assert!(
            layout.text.contains("about 93 billion light-years across"),
            "copied text keeps every space, including wrapped ones"
        );
        let plain = plain("one two three", 7).unwrap();
        let rows: Vec<String> = plain
            .lines
            .iter()
            .map(|line| line.line.to_string())
            .collect();
        assert_eq!(
            rows,
            ["one two", "three"],
            "an overflowing space is dropped, not carried"
        );
        assert_eq!(plain.text, "one two three");
    }

    #[test]
    fn source_ranges_track_wrapping_normalized_code_entities_and_exclude_decoration() {
        let text = "- **中文🦀** then `` `x\ny` `` &amp; &#x1F980;\n\n| A | B |\n|---|---:|\n| x | 中文🦀 value |\n\n    indented\n    code\n";
        for width in [1, 5, 24, 80] {
            let layout = markdown(text, width, false).unwrap();
            for line in &layout.lines {
                let display = line.line.to_string();
                for span in &line.mapping {
                    assert!(text.get(span.source.clone()).is_some());
                    assert!(display.get(span.display.clone()).is_some());
                    if span.exact {
                        assert_eq!(&display[span.display.clone()], &text[span.source.clone()]);
                    }
                }
            }
            let amp = text.find("&amp;").unwrap();
            let mapped: String = layout
                .lines
                .iter()
                .flat_map(|line| {
                    let display = line.line.to_string();
                    line.mapping.iter().filter_map(move |span| {
                        span.intersection(&(amp..amp + 5))
                            .map(|range| display[range].to_owned())
                    })
                })
                .collect();
            assert_eq!(mapped, "&");
            let y = text.find("y`").unwrap();
            let mapped: String = layout
                .lines
                .iter()
                .flat_map(|line| {
                    let display = line.line.to_string();
                    line.mapping.iter().filter_map(move |span| {
                        span.intersection(&(y..y + 1))
                            .map(|range| display[range].to_owned())
                    })
                })
                .collect();
            assert_eq!(
                mapped, "y",
                "normalized code maps its own character, not the whole token"
            );
            let start = text.rfind("code").unwrap();
            let mapped: String = layout
                .lines
                .iter()
                .flat_map(|line| {
                    let display = line.line.to_string();
                    line.mapping.iter().filter_map(move |span| {
                        span.intersection(&(start..start + 4))
                            .map(|range| display[range].to_owned())
                    })
                })
                .collect();
            assert_eq!(
                mapped, "code",
                "indented code does not inherit another line's source"
            );
        }
        for (ascii, marker) in [(false, "• "), (true, "- ")] {
            let wide = markdown(text, 80, ascii).unwrap();
            let first = &wide.lines[0];
            assert!(first.line.to_string().starts_with(marker));
            assert_eq!(
                first.line.spans[0].style.fg,
                Some(crate::theme::Palette::default().subtle),
                "list markers recede behind item text"
            );
            assert!(
                first
                    .mapping
                    .iter()
                    .all(|span| span.display.start >= marker.len())
            );
        }
        let plain = plain("e\u{301}\t中文\nnext", 4).unwrap();
        assert!(
            plain
                .lines
                .iter()
                .flat_map(|line| &line.mapping)
                .any(|span| !span.exact && &"e\u{301}\t中文\nnext"[span.source.clone()] == "\t")
        );
        let reference = "[link][target]\n\n[target]: https://example.test/中文\n";
        let layout = markdown(reference, 12, false).unwrap();
        let start = reference.find("https://").unwrap();
        let mapped: String = layout
            .lines
            .iter()
            .flat_map(|line| {
                let display = line.line.to_string();
                line.mapping.iter().filter_map(move |span| {
                    span.intersection(&(start..reference.len() - 1))
                        .map(|range| display[range].to_owned())
                })
            })
            .collect();
        assert_eq!(
            mapped, "https://example.test/中文",
            "reference destinations retain their definition's source range"
        );
    }
    #[test]
    fn markdown_handles_open_fences_styles_lists_links_and_terminal_safe_unicode() {
        let source = "# 标题\n\n**bold** and *italic*\n\n- one\n  - [x] two\n\n[site](https://example.test)\n\n```rust\nlet 中文 = \"🦀\";\n\u{1b}[31m";
        for width in [1, 5, 40] {
            let layout = markdown(source, width, false).unwrap();
            assert!(
                layout
                    .lines
                    .iter()
                    .all(|line| line.line.width() <= width as usize)
            );
            assert!(
                layout
                    .lines
                    .iter()
                    .all(|line| !line.line.to_string().contains('\u{1b}'))
            );
            assert!(layout.lines.iter().all(|line| line.source <= source.len()));
        }
        let layout = markdown(source, 80, false).unwrap();
        let visible = layout
            .lines
            .iter()
            .map(|line| line.line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(visible.contains("标题") && visible.contains("[x] two"));
        assert!(visible.contains("https://example.test") && visible.contains("let 中文"));
        assert!(!visible.contains("**"));
        assert!(
            layout
                .lines
                .iter()
                .flat_map(|line| &line.line.spans)
                .any(|span| span.content.contains("bold")
                    && span.style.add_modifier.contains(Modifier::BOLD))
        );
        let completed = markdown(&format!("{source}\n```"), 80, false).unwrap();
        assert_eq!(layout.lines, completed.lines);
        let raw = plain("中文🦀\n\u{1b}[31m", 5).unwrap();
        assert!(raw.lines.iter().all(|line| line.line.width() <= 5));
        let inline = markdown(&format!("`{}`", "中文abcdefgh".repeat(10)), 10, false).unwrap();
        assert!(
            inline
                .lines
                .windows(2)
                .all(|lines| lines[0].source < lines[1].source),
            "wrapped inline code needs positions within the event, not one shared anchor"
        );
        assert!(plain(&"\n".repeat(MAX_LINES + 1), 1).is_err());
    }
}
