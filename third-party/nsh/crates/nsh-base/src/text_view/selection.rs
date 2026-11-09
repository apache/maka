//! What a [`super::TextView`]'s ref reads of its selection
//! (`selectedText`): the text, or the selected part of the document as
//! Markdown or HTML.
//!
//! A platform reports the selected text as a copy gives it, and where it
//! starts in the copy of the whole view. That text is found again in the
//! document's own text ([`Document::plain_text`]): the two differ only in
//! their whitespace (a copy breaks blocks with one line break, the document
//! with a blank line), so they are compared without it, the start telling
//! repeated text apart. The document is then cut to the found range, node
//! by node, and written out; a selection of all of it gives the source as
//! it came, when it came in that format.

use std::fmt::Write as _;

use nsh_core::prelude::*;

use super::document::{Alert, Block, ColumnAlign, Document, Inline, ListItem, Table, TableCell};

/// The form [`TextViewApi::selected_text`](super::TextViewApi::selected_text)
/// gives the selection in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
#[non_exhaustive]
pub enum TextSelectionFormat {
    /// The text, as a copy gives it.
    #[default]
    Plain,
    /// The selected nodes as Markdown: the source as written when all of
    /// it is selected.
    Markdown,
    /// The selected nodes as HTML: the source as written when all of it is
    /// selected.
    Html,
}

/// The options of
/// [`TextViewApi::selected_text`](super::TextViewApi::selected_text).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct TextSelectionOptions {
    /// The form to give it in (default `plain`).
    #[prop(default)]
    pub format: TextSelectionFormat,
}

impl TextSelectionOptions {
    /// The selection in `format`.
    pub fn format(format: TextSelectionFormat) -> Self {
        Self { format }
    }
}

/// The selection a platform last reported.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Reported {
    pub text: String,
    pub start: Option<u32>,
}

/// The source the document came from.
pub(crate) enum Source {
    Markdown(String),
    Html(String),
    None,
}

/// The selection `reported` of `doc` (from `source`) in `format`.
pub(crate) fn selected(
    doc: &Document,
    source: &Source,
    reported: &Reported,
    format: TextSelectionFormat,
) -> String {
    let text = reported.text.as_str();
    if text.is_empty() || format == TextSelectionFormat::Plain {
        return text.to_owned();
    }
    let plain = doc.plain_text();
    let Some((from, to)) = locate(&plain, text, reported.start) else {
        // Not found (text the document does not have, as a list's
        // markers): the text itself, in the format.
        return match format {
            TextSelectionFormat::Html => {
                let mut out = String::from("<p>");
                escape(text, &mut out);
                out.push_str("</p>");
                out
            }
            _ => escape_markdown(text),
        };
    };
    let all = plain[..from].trim().is_empty() && plain[to..].trim().is_empty();
    match (format, source, all) {
        (TextSelectionFormat::Markdown, Source::Markdown(s), true)
        | (TextSelectionFormat::Html, Source::Html(s), true) => return s.clone(),
        _ => {}
    }
    let part = if all { doc.clone() } else { cut(doc, from, to) };
    match format {
        TextSelectionFormat::Html => to_html(&part),
        _ => to_markdown(&part),
    }
}

/// The byte range of `text` in `plain`, compared without whitespace: of
/// the matches, the one starting nearest to `start` (UTF-16 units of the
/// view's copy).
fn locate(plain: &str, text: &str, start: Option<u32>) -> Option<(usize, usize)> {
    let hay: Vec<(usize, char)> = plain
        .char_indices()
        .filter(|(_, c)| !c.is_whitespace())
        .collect();
    let needle: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{FFFC}')
        .collect();
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let utf16 = |byte: usize| plain[..byte].encode_utf16().count() as i64;
    let want = i64::from(start.unwrap_or(0));
    let mut best: Option<(i64, usize)> = None;
    for i in 0..=hay.len() - needle.len() {
        if hay[i..i + needle.len()]
            .iter()
            .zip(&needle)
            .all(|((_, a), b)| a == b)
        {
            let distance = (utf16(hay[i].0) - want).abs();
            if best.is_none_or(|(d, _)| distance < d) {
                best = Some((distance, i));
            }
            if start.is_none() {
                break;
            }
        }
    }
    let (_, i) = best?;
    let (last_at, last) = hay[i + needle.len() - 1];
    Some((hay[i].0, last_at + last.len_utf8()))
}

// --- Cutting ----------------------------------------------------------------
//
// Walks the document as `Document::plain_text` writes it, keeping what
// falls in `from..to` (bytes of that text).

struct Cut {
    pos: usize,
    from: usize,
    to: usize,
}

impl Cut {
    fn advance(&mut self, s: &str) {
        self.pos += s.len();
    }

    /// The part of `s` (at the current position) in the range, if any.
    fn take(&mut self, s: &str) -> Option<String> {
        let start = self.pos;
        let end = start + s.len();
        self.pos = end;
        if end <= self.from || start >= self.to {
            return None;
        }
        let a = self.from.saturating_sub(start);
        let b = (self.to - start).min(s.len());
        let (a, b) = (floor(s, a), ceil(s, b));
        (a < b).then(|| s[a..b].to_owned())
    }

    /// Whether `len` bytes from the current position meet the range
    /// (moving past them); an empty node, when it is inside.
    fn meets(&mut self, len: usize) -> bool {
        let start = self.pos;
        self.pos += len;
        if len == 0 {
            return start > self.from && start < self.to;
        }
        start < self.to && start + len > self.from
    }

    fn inlines(&mut self, inlines: &[Inline]) -> Vec<Inline> {
        let mut out = Vec::new();
        for inline in inlines {
            let kept = match inline {
                Inline::Text { text } => self.take(text).map(Inline::text),
                Inline::Keyboard { text } => self.take(text).map(|text| Inline::Keyboard { text }),
                Inline::Code { code } => self.take(code).map(|code| Inline::Code { code }),
                Inline::Source { content, .. } => {
                    out.extend(self.inlines(content));
                    None
                }
                Inline::Strong { content }
                | Inline::Emphasis { content }
                | Inline::Strikethrough { content }
                | Inline::Underline { content }
                | Inline::Highlight { content, .. }
                | Inline::Superscript { content }
                | Inline::Subscript { content }
                | Inline::Small { content }
                | Inline::Link { content, .. } => {
                    let inner = self.inlines(content);
                    (!inner.is_empty()).then(|| {
                        let mut node = inline.clone();
                        if let Some(c) = content_mut(&mut node) {
                            *c = inner;
                        }
                        node
                    })
                }
                other => {
                    let len = other.plain_text().len();
                    self.meets(len).then(|| other.clone())
                }
            };
            out.extend(kept);
        }
        out
    }

    fn blocks(&mut self, blocks: &[Block], sep: &str) -> Vec<Block> {
        let mut out = Vec::new();
        for (i, b) in blocks.iter().enumerate() {
            if i > 0 {
                self.advance(sep);
            }
            out.extend(self.block(b));
        }
        out
    }

    fn block(&mut self, block: &Block) -> Option<Block> {
        match block {
            Block::Paragraph { content } => {
                let content = self.inlines(content);
                (!content.is_empty()).then_some(Block::Paragraph { content })
            }
            Block::Heading {
                level,
                content,
                anchor,
            } => {
                let content = self.inlines(content);
                (!content.is_empty()).then(|| Block::Heading {
                    level: *level,
                    content,
                    anchor: anchor.clone(),
                })
            }
            Block::Blockquote { children, alert } => {
                let children = self.blocks(children, "\n\n");
                (!children.is_empty()).then_some(Block::Blockquote {
                    children,
                    alert: *alert,
                })
            }
            Block::List {
                ordered,
                start,
                loose,
                items,
            } => {
                let mut kept = Vec::new();
                let mut first = None;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.advance("\n");
                    }
                    let children = self.blocks(&item.children, "\n");
                    if !children.is_empty() {
                        first.get_or_insert(i);
                        kept.push(ListItem {
                            checked: item.checked,
                            children,
                        });
                    }
                }
                (!kept.is_empty()).then(|| Block::List {
                    ordered: *ordered,
                    start: start + first.unwrap_or(0) as u32,
                    loose: *loose,
                    items: kept,
                })
            }
            Block::CodeBlock(code) => {
                let text = code.code.trim_end_matches('\n');
                self.take(text).map(|part| {
                    let mut code = code.clone();
                    code.code = part;
                    Block::CodeBlock(code)
                })
            }
            Block::Table(table) => {
                let rows: Vec<&Vec<TableCell>> =
                    std::iter::once(&table.head).chain(&table.rows).collect();
                let mut kept = Vec::new();
                for (i, row) in rows.iter().enumerate() {
                    if i > 0 {
                        self.advance("\n");
                    }
                    let mut any = false;
                    let mut cells = Vec::new();
                    for (j, cell) in row.iter().enumerate() {
                        if j > 0 {
                            self.advance("\t");
                        }
                        let content = self.inlines(&cell.content);
                        any |= !content.is_empty();
                        cells.push(TableCell {
                            content,
                            colspan: cell.colspan,
                        });
                    }
                    if any {
                        kept.push((i, cells));
                    }
                }
                if kept.is_empty() {
                    return None;
                }
                // The header stays a header; rows without it keep the
                // table's own header.
                let mut kept = kept.into_iter();
                let head = if kept.as_slice()[0].0 == 0 {
                    kept.next().map(|(_, c)| c).unwrap_or_default()
                } else {
                    table.head.clone()
                };
                Some(Block::Table(Table {
                    align: table.align.clone(),
                    head,
                    rows: kept.map(|(_, c)| c).collect(),
                }))
            }
            Block::Details {
                open,
                summary,
                children,
            } => {
                let summary_part = self.inlines(summary);
                let children = if children.is_empty() {
                    Vec::new()
                } else {
                    self.advance("\n\n");
                    self.blocks(children, "\n\n")
                };
                if summary_part.is_empty() && children.is_empty() {
                    return None;
                }
                if children.is_empty() {
                    return Some(Block::Paragraph {
                        content: summary_part,
                    });
                }
                Some(Block::Details {
                    open: *open,
                    summary: summary.clone(),
                    children,
                })
            }
            other => {
                let len = other.plain_text().len();
                self.meets(len).then(|| other.clone())
            }
        }
    }
}

fn content_mut(inline: &mut Inline) -> Option<&mut Vec<Inline>> {
    match inline {
        Inline::Strong { content }
        | Inline::Emphasis { content }
        | Inline::Strikethrough { content }
        | Inline::Underline { content }
        | Inline::Highlight { content, .. }
        | Inline::Superscript { content }
        | Inline::Subscript { content }
        | Inline::Small { content }
        | Inline::Link { content, .. } => Some(content),
        _ => None,
    }
}

fn floor(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// The part of `doc` in bytes `from..to` of its plain text.
fn cut(doc: &Document, from: usize, to: usize) -> Document {
    let mut cut = Cut { pos: 0, from, to };
    let mut blocks = Vec::new();
    let notes = doc.footnotes.iter().flat_map(|f| f.children.iter());
    for (i, block) in doc.blocks.iter().chain(notes).enumerate() {
        if i > 0 {
            cut.advance("\n\n");
        }
        blocks.extend(cut.block(block));
    }
    Document::new(blocks)
}

// --- Markdown ---------------------------------------------------------------

/// `doc` as Markdown.
pub(crate) fn to_markdown(doc: &Document) -> String {
    let mut out = String::new();
    md_blocks(&doc.blocks, "", &mut out);
    if !doc.footnotes.is_empty() {
        for note in &doc.footnotes {
            out.push_str("\n\n");
            let mut body = String::new();
            md_blocks(&note.children, "    ", &mut body);
            let _ = write!(out, "[^{}]: {}", note.label, body.trim_start());
        }
    }
    out
}

/// Writes `blocks`, each line after the first prefixed by `indent`.
fn md_blocks(blocks: &[Block], indent: &str, out: &mut String) {
    for (i, b) in blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
            out.push_str(indent.trim_end());
            out.push('\n');
            out.push_str(indent);
        }
        md_block(b, indent, out);
    }
}

fn md_block(block: &Block, indent: &str, out: &mut String) {
    match block {
        Block::Paragraph { content } => md_inlines(content, out),
        Block::Heading { level, content, .. } => {
            out.push_str(&"#".repeat((*level).clamp(1, 6) as usize));
            out.push(' ');
            md_inlines(content, out);
        }
        Block::Blockquote { children, alert } => {
            let inner = format!("{indent}> ");
            if let Some(alert) = alert {
                let name = match alert {
                    Alert::Note => "NOTE",
                    Alert::Tip => "TIP",
                    Alert::Important => "IMPORTANT",
                    Alert::Warning => "WARNING",
                    Alert::Caution => "CAUTION",
                };
                let _ = write!(out, "> [!{name}]\n{inner}");
            } else {
                out.push_str("> ");
            }
            md_blocks(children, &inner, out);
        }
        Block::List {
            ordered,
            start,
            loose,
            items,
        } => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push('\n');
                    if *loose {
                        out.push('\n');
                    }
                    out.push_str(indent);
                }
                let marker = if *ordered {
                    format!("{}. ", start + i as u32)
                } else {
                    "- ".to_owned()
                };
                out.push_str(&marker);
                match item.checked {
                    Some(true) => out.push_str("[x] "),
                    Some(false) => out.push_str("[ ] "),
                    None => {}
                }
                let inner = format!("{indent}{}", " ".repeat(marker.len()));
                md_blocks(&item.children, &inner, out);
            }
        }
        Block::CodeBlock(code) => {
            let fence = if code.code.contains("```") {
                "````"
            } else {
                "```"
            };
            out.push_str(fence);
            if let Some(lang) = &code.language {
                out.push_str(lang);
            }
            if let Some(meta) = &code.meta {
                out.push(' ');
                out.push_str(meta);
            }
            for line in code.code.trim_end_matches('\n').split('\n') {
                out.push('\n');
                out.push_str(indent);
                out.push_str(line);
            }
            out.push('\n');
            out.push_str(indent);
            out.push_str(fence);
        }
        Block::Math { tex, .. } => {
            let _ = write!(out, "$$\n{indent}{tex}\n{indent}$$");
        }
        Block::Table(table) => {
            let columns = table.columns().max(1);
            let row = |cells: &[TableCell], out: &mut String| {
                out.push('|');
                for cell in cells {
                    out.push(' ');
                    let mut text = String::new();
                    md_inlines(&cell.content, &mut text);
                    out.push_str(&text.replace('|', "\\|").replace('\n', " "));
                    out.push_str(" |");
                }
            };
            row(&table.head, out);
            out.push('\n');
            out.push_str(indent);
            out.push('|');
            for i in 0..columns {
                out.push_str(match table.align.get(i).copied().unwrap_or_default() {
                    ColumnAlign::None => " --- |",
                    ColumnAlign::Left => " :-- |",
                    ColumnAlign::Center => " :-: |",
                    ColumnAlign::Right => " --: |",
                });
            }
            for r in &table.rows {
                out.push('\n');
                out.push_str(indent);
                row(r, out);
            }
        }
        Block::Rule => out.push_str("---"),
        Block::Details {
            open,
            summary,
            children,
        } => {
            out.push_str(if *open { "<details open>" } else { "<details>" });
            out.push_str("<summary>");
            html_inlines(summary, out);
            let _ = write!(out, "</summary>\n{indent}\n{indent}");
            md_blocks(children, indent, out);
            let _ = write!(out, "\n{indent}\n{indent}</details>");
        }
        Block::Custom(node) => {
            if node.children.is_empty() {
                out.push_str(&escape_markdown(&block.plain_text()));
            } else {
                md_blocks(&node.children, indent, out);
            }
        }
    }
}

fn md_inlines(inlines: &[Inline], out: &mut String) {
    for inline in inlines {
        md_inline(inline, out);
    }
}

fn md_inline(inline: &Inline, out: &mut String) {
    let wrap = |mark: &str, content: &[Inline], out: &mut String| {
        out.push_str(mark);
        md_inlines(content, out);
        out.push_str(mark);
    };
    let tag = |name: &str, content: &[Inline], out: &mut String| {
        let _ = write!(out, "<{name}>");
        md_inlines(content, out);
        let _ = write!(out, "</{name}>");
    };
    match inline {
        Inline::Source { content, .. } => md_inlines(content, out),
        Inline::Text { text } => out.push_str(&escape_markdown(text)),
        Inline::Strong { content } => wrap("**", content, out),
        Inline::Emphasis { content } => wrap("*", content, out),
        Inline::Strikethrough { content } => wrap("~~", content, out),
        Inline::Underline { content } => tag("u", content, out),
        Inline::Highlight { content, .. } => tag("mark", content, out),
        Inline::Superscript { content } => tag("sup", content, out),
        Inline::Subscript { content } => tag("sub", content, out),
        Inline::Small { content } => tag("small", content, out),
        Inline::Code { code } => {
            let ticks = if code.contains('`') { "``" } else { "`" };
            let pad = if code.starts_with('`') || code.ends_with('`') {
                " "
            } else {
                ""
            };
            let _ = write!(out, "{ticks}{pad}{code}{pad}{ticks}");
        }
        Inline::Keyboard { text } => {
            out.push_str("<kbd>");
            escape(text, out);
            out.push_str("</kbd>");
        }
        Inline::Link {
            url,
            title,
            content,
        } => {
            out.push('[');
            md_inlines(content, out);
            let _ = write!(out, "]({}", md_url(url));
            if let Some(title) = title {
                let _ = write!(out, " \"{}\"", title.replace('"', "\\\""));
            }
            out.push(')');
        }
        Inline::Image(image) => {
            let _ = write!(
                out,
                "![{}]({}",
                escape_markdown(&image.alt),
                md_url(&image.src)
            );
            if let Some(title) = &image.title {
                let _ = write!(out, " \"{}\"", title.replace('"', "\\\""));
            }
            out.push(')');
        }
        Inline::Math { tex } => {
            let _ = write!(out, "${tex}$");
        }
        Inline::Break => out.push_str("\\\n"),
        Inline::FootnoteReference { label, .. } => {
            let _ = write!(out, "[^{label}]");
        }
        Inline::Custom(node) => {
            if node.content.is_empty() {
                out.push_str(&escape_markdown(&inline.plain_text()));
            } else {
                md_inlines(&node.content, out);
            }
        }
    }
}

fn md_url(url: &str) -> String {
    if url.contains([' ', '(', ')']) {
        format!("<{url}>")
    } else {
        url.to_owned()
    }
}

/// `text` with Markdown's markup characters escaped.
fn escape_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '~' | '|' | '$'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// --- HTML -------------------------------------------------------------------

/// `doc` as HTML.
pub(crate) fn to_html(doc: &Document) -> String {
    let mut out = String::new();
    html_blocks(&doc.blocks, &mut out);
    if !doc.footnotes.is_empty() {
        out.push_str("<section class=\"footnotes\"><ol>");
        for note in &doc.footnotes {
            out.push_str("<li id=\"fn-");
            escape(&note.label, &mut out);
            out.push_str("\">");
            html_blocks(&note.children, &mut out);
            out.push_str("</li>");
        }
        out.push_str("</ol></section>");
    }
    out
}

fn html_blocks(blocks: &[Block], out: &mut String) {
    for (i, b) in blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        html_block(b, out);
    }
}

fn html_block(block: &Block, out: &mut String) {
    match block {
        Block::Paragraph { content } => {
            out.push_str("<p>");
            html_inlines(content, out);
            out.push_str("</p>");
        }
        Block::Heading { level, content, .. } => {
            let level = (*level).clamp(1, 6);
            let _ = write!(out, "<h{level}>");
            html_inlines(content, out);
            let _ = write!(out, "</h{level}>");
        }
        Block::Blockquote { children, .. } => {
            out.push_str("<blockquote>");
            html_blocks(children, out);
            out.push_str("</blockquote>");
        }
        Block::List {
            ordered,
            start,
            items,
            ..
        } => {
            if *ordered {
                if *start == 1 {
                    out.push_str("<ol>");
                } else {
                    let _ = write!(out, "<ol start=\"{start}\">");
                }
            } else {
                out.push_str("<ul>");
            }
            for item in items {
                out.push_str("<li>");
                match item.checked {
                    Some(true) => out.push_str("<input type=\"checkbox\" checked disabled> "),
                    Some(false) => out.push_str("<input type=\"checkbox\" disabled> "),
                    None => {}
                }
                // A tight item's paragraph is its text.
                match item.children.as_slice() {
                    [Block::Paragraph { content }] => html_inlines(content, out),
                    children => html_blocks(children, out),
                }
                out.push_str("</li>");
            }
            out.push_str(if *ordered { "</ol>" } else { "</ul>" });
        }
        Block::CodeBlock(code) => {
            out.push_str("<pre><code");
            if let Some(lang) = &code.language {
                out.push_str(" class=\"language-");
                escape(lang, out);
                out.push('"');
            }
            out.push('>');
            escape(code.code.trim_end_matches('\n'), out);
            out.push_str("</code></pre>");
        }
        Block::Math { tex, .. } => {
            out.push_str("<div class=\"math\">$$");
            escape(tex, out);
            out.push_str("$$</div>");
        }
        Block::Table(table) => {
            let align = |i: usize| match table.align.get(i).copied().unwrap_or_default() {
                ColumnAlign::None => "",
                ColumnAlign::Left => " align=\"left\"",
                ColumnAlign::Center => " align=\"center\"",
                ColumnAlign::Right => " align=\"right\"",
            };
            let row = |cells: &[TableCell], tag: &str, out: &mut String| {
                out.push_str("<tr>");
                let mut col = 0;
                for cell in cells {
                    let _ = write!(out, "<{tag}{}", align(col));
                    if let Some(span) = cell.colspan.filter(|&n| n > 1) {
                        let _ = write!(out, " colspan=\"{span}\"");
                    }
                    out.push('>');
                    html_inlines(&cell.content, out);
                    let _ = write!(out, "</{tag}>");
                    col += cell.span();
                }
                out.push_str("</tr>");
            };
            out.push_str("<table><thead>");
            row(&table.head, "th", out);
            out.push_str("</thead>");
            if !table.rows.is_empty() {
                out.push_str("<tbody>");
                for r in &table.rows {
                    row(r, "td", out);
                }
                out.push_str("</tbody>");
            }
            out.push_str("</table>");
        }
        Block::Rule => out.push_str("<hr>"),
        Block::Details {
            open,
            summary,
            children,
        } => {
            out.push_str(if *open { "<details open>" } else { "<details>" });
            out.push_str("<summary>");
            html_inlines(summary, out);
            out.push_str("</summary>");
            html_blocks(children, out);
            out.push_str("</details>");
        }
        Block::Custom(node) => {
            if !node.children.is_empty() {
                html_blocks(&node.children, out);
            } else {
                out.push_str("<p>");
                escape(&block.plain_text(), out);
                out.push_str("</p>");
            }
        }
    }
}

fn html_inlines(inlines: &[Inline], out: &mut String) {
    for inline in inlines {
        html_inline(inline, out);
    }
}

fn html_inline(inline: &Inline, out: &mut String) {
    let tag = |name: &str, content: &[Inline], out: &mut String| {
        let _ = write!(out, "<{name}>");
        html_inlines(content, out);
        let _ = write!(out, "</{name}>");
    };
    match inline {
        Inline::Source { content, .. } => html_inlines(content, out),
        Inline::Text { text } => escape(text, out),
        Inline::Strong { content } => tag("strong", content, out),
        Inline::Emphasis { content } => tag("em", content, out),
        Inline::Strikethrough { content } => tag("del", content, out),
        Inline::Underline { content } => tag("u", content, out),
        Inline::Highlight { content, .. } => tag("mark", content, out),
        Inline::Superscript { content } => tag("sup", content, out),
        Inline::Subscript { content } => tag("sub", content, out),
        Inline::Small { content } => tag("small", content, out),
        Inline::Code { code } => {
            out.push_str("<code>");
            escape(code, out);
            out.push_str("</code>");
        }
        Inline::Keyboard { text } => {
            out.push_str("<kbd>");
            escape(text, out);
            out.push_str("</kbd>");
        }
        Inline::Link {
            url,
            title,
            content,
        } => {
            out.push_str("<a href=\"");
            escape(url, out);
            out.push('"');
            if let Some(title) = title {
                out.push_str(" title=\"");
                escape(title, out);
                out.push('"');
            }
            out.push('>');
            html_inlines(content, out);
            out.push_str("</a>");
        }
        Inline::Image(image) => {
            out.push_str("<img src=\"");
            escape(&image.src, out);
            out.push_str("\" alt=\"");
            escape(&image.alt, out);
            out.push('"');
            if let Some(title) = &image.title {
                out.push_str(" title=\"");
                escape(title, out);
                out.push('"');
            }
            out.push('>');
        }
        Inline::Math { tex } => {
            out.push_str("<span class=\"math\">$");
            escape(tex, out);
            out.push_str("$</span>");
        }
        Inline::Break => out.push_str("<br>"),
        Inline::FootnoteReference { label, index } => {
            out.push_str("<sup><a href=\"#fn-");
            escape(label, out);
            let _ = write!(out, "\">{index}</a></sup>");
        }
        Inline::Custom(node) => {
            if node.content.is_empty() {
                escape(&inline.plain_text(), out);
            } else {
                html_inlines(&node.content, out);
            }
        }
    }
}

/// Writes `text` with HTML's special characters escaped.
fn escape(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_view::Parser;

    fn doc(md: &str) -> Document {
        Parser::new().markdown(md)
    }

    fn sel(md: &str, text: &str, format: TextSelectionFormat) -> String {
        let reported = Reported {
            text: text.to_owned(),
            start: None,
        };
        selected(
            &doc(md),
            &Source::Markdown(md.to_owned()),
            &reported,
            format,
        )
    }

    #[test]
    fn plain_is_the_text() {
        assert_eq!(
            sel("Quote **this**", "this", TextSelectionFormat::Plain),
            "this"
        );
    }

    #[test]
    fn all_gives_the_source() {
        let md = "# Title\n\nQuote **this** part";
        assert_eq!(
            sel(md, "Title\nQuote this part", TextSelectionFormat::Markdown),
            md
        );
        assert_eq!(
            sel(md, "Title\nQuote this part", TextSelectionFormat::Html),
            "<h1>Title</h1>\n<p>Quote <strong>this</strong> part</p>"
        );
    }

    #[test]
    fn a_part_keeps_its_marks() {
        let md = "Quote **this** part";
        assert_eq!(
            sel(md, "ote this pa", TextSelectionFormat::Markdown),
            "ote **this** pa"
        );
        assert_eq!(sel(md, "is pa", TextSelectionFormat::Markdown), "**is** pa");
        assert_eq!(
            sel(md, "is pa", TextSelectionFormat::Html),
            "<p><strong>is</strong> pa</p>"
        );
    }

    #[test]
    fn across_blocks() {
        let md = "# Head\n\n- one\n- two *x*\n- three\n\n```rust\nlet a = 1;\nlet b = 2;\n```";
        assert_eq!(
            sel(md, "two x\nthree\nlet a", TextSelectionFormat::Markdown),
            "- two *x*\n- three\n\n```rust\nlet a\n```"
        );
        assert_eq!(
            sel(md, "ad\none", TextSelectionFormat::Html),
            "<h1>ad</h1>\n<ul><li>one</li></ul>"
        );
    }

    #[test]
    fn ordered_list_keeps_its_numbers() {
        let md = "1. a\n2. b\n3. c";
        assert_eq!(sel(md, "b\nc", TextSelectionFormat::Markdown), "2. b\n3. c");
    }

    #[test]
    fn repeated_text_by_start() {
        let md = "same\n\nsame";
        let reported = Reported {
            text: "same".into(),
            start: Some(5),
        };
        let d = doc(md);
        let source = Source::Markdown(md.into());
        let out = selected(&d, &source, &reported, TextSelectionFormat::Html);
        assert_eq!(out, "<p>same</p>");
        assert_eq!(locate(&d.plain_text(), "same", Some(5)), Some((6, 10)));
        assert_eq!(locate(&d.plain_text(), "same", Some(0)), Some((0, 4)));
    }

    #[test]
    fn table_rows_keep_the_header() {
        let md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
        assert_eq!(
            sel(md, "3\t4", TextSelectionFormat::Markdown),
            "| a | b |\n| --- | --- |\n| 3 | 4 |"
        );
    }

    #[test]
    fn unknown_text_falls_back() {
        assert_eq!(
            sel("abc", "<x>", TextSelectionFormat::Html),
            "<p>&lt;x&gt;</p>"
        );
    }
}
