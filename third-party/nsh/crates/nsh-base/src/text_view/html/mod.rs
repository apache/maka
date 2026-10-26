//! HTML into a [`Document`]: fragments (an AI model's reply, HTML inside
//! Markdown) and whole pages (their body, as a reader mode shows it).
//!
//! html5ever builds the tree as a browser does (unclosed and misplaced tags
//! included); the reader then walks it in one of two contexts. In block
//! context each element is a block of the model, or a container whose
//! children are read in block context (a `<div>`, a `<section>`, an unknown
//! element holding blocks), and runs of inline content between blocks
//! become paragraphs. In inline context elements are inline content, and
//! blocks met there (`<span><p>…</p></span>`) are their content on lines of
//! their own. Whitespace collapses as a browser collapses it, except in
//! `<pre>`.

use std::{collections::BTreeMap, mem, rc::Rc};

use html5ever::{ParseOpts, parse_document, tendril::TendrilSink};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use regex::Regex;

use super::{
    Document, Parser,
    common::{Slugger, apply_patterns},
    document::{
        Alert, Block, CodeBlock, ColumnAlign, CustomNode, Image, ImageLength, Inline, ListItem,
        Table, TableCell, inline_text,
    },
};

#[cfg(test)]
mod tests;

/// Elements below this depth are not read: the tree is walked recursively,
/// and malformed or hostile input may nest without bound.
const MAX_DEPTH: usize = 256;

/// Columns a cell's `colspan` spans at most.
const MAX_COLSPAN: usize = 64;

/// Elements that are blocks: read in block context, and the reason an
/// unknown element holding them is a container.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "legend",
    "li",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "pre",
    "search",
    "section",
    "summary",
    "table",
    "ul",
];

/// Elements whose content is never shown: metadata, scripts, form controls
/// and embedded objects with no text of their own.
const DROPPED: &[&str] = &[
    "audio", "base", "canvas", "colgroup", "datalist", "embed", "head", "iframe", "input", "link",
    "meta", "noscript", "object", "option", "param", "script", "select", "source", "style", "svg",
    "template", "textarea", "title", "track", "video",
];

/// Void elements: a `<tag … />` extension of one of these names is left as
/// written, the rewrite to `<tag …></tag>` would add a second element.
const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

/// HTML `source` (a fragment or a whole page) read into a document.
pub(crate) fn parse(parser: &Parser, source: &str) -> Document {
    Document::new(blocks(parser, source))
}

/// HTML fragment `source` read as blocks (flow HTML in Markdown), with
/// the parser's pattern extensions applied.
pub(crate) fn blocks(parser: &Parser, source: &str) -> Vec<Block> {
    let (_dom, body) = body(parser, source);
    Reader::new(parser).blocks_of(&body, 0, None)
}

/// HTML fragment `source` read as inline content (inline HTML in Markdown:
/// `<b>x</b>`, `<sup>2</sup>`, `<br>`). It is part of a longer text, so a
/// space at either end stays (one, collapsed), and pattern extensions are
/// left to the caller, which applies them to the whole text.
pub(crate) fn inlines(parser: &Parser, source: &str) -> Vec<Inline> {
    let (_dom, body) = body(parser, source);
    let mut reader = Reader::new(parser);
    let mut out = Vec::new();
    reader.inline_children(&body, &mut out, 0);
    // A block at the end leaves the line break that would separate it from
    // what follows in its block.
    let last = body
        .children
        .borrow()
        .iter()
        .rev()
        .find(|c| !is_blank_text(c))
        .cloned();
    if last
        .as_ref()
        .and_then(element_name)
        .is_some_and(|n| BLOCKS.contains(&n))
        && matches!(out.last(), Some(Inline::Break))
    {
        out.pop();
    }
    // html5ever drops whitespace before the body's first content.
    let mut ws = Whitespace {
        pending: source.starts_with(is_html_space),
        line_start: false,
    };
    let mut out = collapse(out, &mut ws);
    if ws.pending {
        push_text(&mut out, " ");
    }
    out
}

/// `source` parsed, and its body (the document itself if it has none).
///
/// The tree is returned to be held while the body is read: dropping it
/// empties its nodes (rcdom drops without recursion by taking every
/// node's children), those still referenced included.
fn body(parser: &Parser, source: &str) -> (RcDom, Handle) {
    let source = close_extension_tags(parser, source);
    let dom = parse_document(RcDom::default(), ParseOpts::default()).one(source.as_ref());
    let html = dom
        .document
        .children
        .borrow()
        .iter()
        .find(|c| element_name(c) == Some("html"))
        .cloned();
    let body = html
        .and_then(|html| {
            html.children
                .borrow()
                .iter()
                .find(|c| element_name(c) == Some("body"))
                .cloned()
        })
        .unwrap_or_else(|| dom.document.clone());
    (dom, body)
}

/// `source` with `<tag … />` of the extensions' tags written
/// `<tag …></tag>`: HTML ignores the slash of a non-void element, so the
/// element would otherwise hold everything after it, while extension tags
/// are written as JSX writes them.
fn close_extension_tags<'s>(parser: &Parser, source: &'s str) -> std::borrow::Cow<'s, str> {
    let mut source = std::borrow::Cow::Borrowed(source);
    for ext in &parser.extensions {
        let Some(tag) = ext.tag.as_deref() else {
            continue;
        };
        if tag.is_empty()
            || VOID.contains(&tag.to_ascii_lowercase().as_str())
            || !source.contains("/>")
        {
            continue;
        }
        let Ok(regex) = Regex::new(&format!(
            r"(?i)<({})((?:\s[^<>]*?)?)\s*/>",
            regex::escape(tag)
        )) else {
            continue;
        };
        if let std::borrow::Cow::Owned(replaced) = regex.replace_all(&source, "<$1$2></$1>") {
            source = std::borrow::Cow::Owned(replaced);
        }
    }
    source
}

/// One walk of a tree.
struct Reader<'p> {
    parser: &'p Parser,
    slugger: Slugger,
    /// A task item's checkbox, read as its state rather than as content.
    checkbox: Option<Handle>,
}

/// Blocks being read, and the run of inline content after the last one.
#[derive(Default)]
struct Flow {
    blocks: Vec<Block>,
    run: Vec<Inline>,
}

impl<'p> Reader<'p> {
    fn new(parser: &'p Parser) -> Self {
        Self {
            parser,
            slugger: Slugger::default(),
            checkbox: None,
        }
    }

    // --- Blocks ---------------------------------------------------------

    /// The children of `node` read in block context, all but `skip`.
    fn blocks_of(&mut self, node: &Handle, depth: usize, skip: Option<&Handle>) -> Vec<Block> {
        let mut flow = Flow::default();
        if depth < MAX_DEPTH {
            for child in children(node) {
                if skip.is_some_and(|s| Rc::ptr_eq(s, &child)) {
                    continue;
                }
                self.block_node(&child, &mut flow, depth + 1);
            }
        }
        self.flush(&mut flow);
        flow.blocks
    }

    /// The run of inline content as a paragraph, unless it shows nothing.
    fn flush(&mut self, flow: &mut Flow) {
        let content = self.finish(mem::take(&mut flow.run));
        if !content.is_empty() {
            flow.blocks.push(Block::Paragraph { content });
        }
    }

    /// `block`, after the run of inline content before it.
    fn push_block(&mut self, flow: &mut Flow, block: Block) {
        self.flush(flow);
        flow.blocks.push(block);
    }

    fn block_node(&mut self, node: &Handle, flow: &mut Flow, depth: usize) {
        let NodeData::Element { name, .. } = &node.data else {
            if let NodeData::Text { contents } = &node.data {
                push_text(&mut flow.run, &contents.borrow());
            }
            return;
        };
        let name = &*name.local;
        if is_hidden(node) || DROPPED.contains(&name) {
            return;
        }
        if let Some(ext) = self.extension(name) {
            if is_standalone(node) {
                let mut custom = self.custom(node, ext);
                custom.children = self.blocks_of(node, depth, None);
                self.push_block(flow, Block::Custom(custom));
            } else {
                self.inline_node(node, &mut flow.run, depth);
            }
            return;
        }
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let content = self.inline_content(node, depth);
                let anchor = match attr(node, "id").filter(|id| !id.is_empty()) {
                    Some(id) => id,
                    None => {
                        let mut text = String::new();
                        inline_text(&content, &mut text);
                        self.slugger.slug(&text)
                    }
                };
                let level = name.as_bytes()[1] - b'0';
                self.push_block(
                    flow,
                    Block::Heading {
                        level,
                        content,
                        anchor: Some(anchor),
                    },
                );
            }
            "blockquote" => {
                let children = self.blocks_of(node, depth, None);
                self.push_block(
                    flow,
                    Block::Blockquote {
                        children,
                        alert: None,
                    },
                );
            }
            "ul" | "ol" | "menu" | "dir" => {
                let list = self.list(node, name == "ol", depth);
                self.push_block(flow, list);
            }
            "pre" => self.push_block(flow, Block::CodeBlock(code_block(node))),
            "hr" => self.push_block(flow, Block::Rule),
            "table" => self.table(node, flow, depth),
            "details" => {
                let summary = children(node)
                    .into_iter()
                    .find(|c| element_name(c) == Some("summary"));
                let summary_content = match &summary {
                    Some(summary) => self.inline_content(summary, depth),
                    None => Vec::new(),
                };
                let children = self.blocks_of(node, depth, summary.as_ref());
                self.push_block(
                    flow,
                    Block::Details {
                        open: attr(node, "open").is_some(),
                        summary: summary_content,
                        children,
                    },
                );
            }
            "dt" => {
                let content = self.inline_content(node, depth);
                if !content.is_empty() {
                    self.push_block(
                        flow,
                        Block::Paragraph {
                            content: vec![Inline::Strong { content }],
                        },
                    );
                }
            }
            "math" if attr(node, "display").as_deref() == Some("block") => {
                match tex_annotation(node) {
                    Some(tex) => self.push_block(
                        flow,
                        Block::Math {
                            tex,
                            source: Vec::new(),
                        },
                    ),
                    None => self.inline_node(node, &mut flow.run, depth),
                }
            }
            "div" if alert(node).is_some() => {
                // GitHub's alerts as its HTML writes them: the title is the
                // alert's kind, which the view shows its own way.
                let title = children(node)
                    .into_iter()
                    .find(|c| has_class(c, "markdown-alert-title"));
                let children = self.blocks_of(node, depth, title.as_ref());
                self.push_block(
                    flow,
                    Block::Blockquote {
                        children,
                        alert: alert(node),
                    },
                );
            }
            _ if BLOCKS.contains(&name) || (depth < MAX_DEPTH && contains_block(node, depth)) => {
                // A container: its children are blocks among the others.
                self.flush(flow);
                if depth < MAX_DEPTH {
                    for child in children(node) {
                        self.block_node(&child, flow, depth + 1);
                    }
                }
                self.flush(flow);
            }
            _ => self.inline_node(node, &mut flow.run, depth),
        }
    }

    fn list(&mut self, node: &Handle, ordered: bool, depth: usize) -> Block {
        let mut items = Vec::new();
        let mut loose = false;
        // Content outside `<li>` (invalid, but written) is an item of its own.
        let mut stray = Flow::default();
        for child in children(node) {
            if element_name(&child) == Some("li") {
                self.flush(&mut stray);
                if !stray.blocks.is_empty() {
                    items.push(ListItem::new(mem::take(&mut stray.blocks)));
                }
                loose |= children(&child)
                    .iter()
                    .any(|c| element_name(c) == Some("p"));
                let checkbox = task_checkbox(&child);
                let checked = checkbox.as_ref().map(|c| attr(c, "checked").is_some());
                let saved = mem::replace(&mut self.checkbox, checkbox);
                let children = self.blocks_of(&child, depth + 1, None);
                self.checkbox = saved;
                items.push(ListItem { checked, children });
            } else if depth < MAX_DEPTH {
                self.block_node(&child, &mut stray, depth + 1);
            }
        }
        self.flush(&mut stray);
        if !stray.blocks.is_empty() {
            items.push(ListItem::new(stray.blocks));
        }
        let start = attr(node, "start")
            .and_then(|s| s.trim().parse::<i64>().ok())
            .map_or(1, |s| s.clamp(0, u32::MAX as i64) as u32);
        Block::List {
            ordered,
            start,
            loose,
            items,
        }
    }

    fn table(&mut self, node: &Handle, flow: &mut Flow, depth: usize) {
        if depth >= MAX_DEPTH {
            return;
        }
        let mut rows = Vec::new();
        let mut foot = Vec::new();
        let mut has_head = false;
        for child in children(node) {
            match element_name(&child) {
                Some("caption") => {
                    let content = self.inline_content(&child, depth);
                    if !content.is_empty() {
                        self.push_block(flow, Block::Paragraph { content });
                    }
                }
                Some("thead") if !has_head => {
                    has_head = true;
                    let head = children(&child)
                        .into_iter()
                        .filter(|r| element_name(r) == Some("tr"));
                    // The head goes first wherever it is written.
                    rows.splice(0..0, head);
                }
                Some("thead" | "tbody") => rows.extend(
                    children(&child)
                        .into_iter()
                        .filter(|r| element_name(r) == Some("tr")),
                ),
                Some("tfoot") => foot.extend(
                    children(&child)
                        .into_iter()
                        .filter(|r| element_name(r) == Some("tr")),
                ),
                Some("tr") => rows.push(child),
                _ => {}
            }
        }
        rows.extend(foot);
        let mut rows = rows.into_iter().map(|row| self.row(&row, depth + 1));
        let Some((head, head_align)) = rows.next() else {
            return;
        };
        let rows: Vec<_> = rows.collect();
        // Columns by the cells' spans, not their count.
        let width = |row: &[TableCell]| row.iter().map(TableCell::span).sum::<usize>();
        let columns = rows
            .iter()
            .map(|(r, _)| width(r))
            .chain([width(&head)])
            .max()
            .unwrap_or(0);
        if columns == 0 {
            return;
        }
        // A column aligns as its header cell says, else as its first row's.
        let mut align: Vec<ColumnAlign> = (0..columns)
            .map(|i| head_align.get(i).copied().unwrap_or_default())
            .collect();
        if let Some((_, first)) = rows.first() {
            for (a, b) in align.iter_mut().zip(first) {
                if *a == ColumnAlign::None {
                    *a = *b;
                }
            }
        }
        let pad = |mut row: Vec<TableCell>| {
            let missing = columns.saturating_sub(width(&row));
            row.extend(std::iter::repeat_with(TableCell::default).take(missing));
            row
        };
        let table = Table {
            align,
            head: pad(head),
            rows: rows.into_iter().map(|(row, _)| pad(row)).collect(),
        };
        self.push_block(flow, Block::Table(table));
    }

    /// The cells of row `node`, and their alignments.
    fn row(&mut self, node: &Handle, depth: usize) -> (Vec<TableCell>, Vec<ColumnAlign>) {
        let mut cells = Vec::new();
        let mut align = Vec::new();
        for cell in children(node) {
            if !matches!(element_name(&cell), Some("th" | "td")) {
                continue;
            }
            let span = attr(&cell, "colspan")
                .and_then(|s| s.trim().parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, MAX_COLSPAN);
            let a = cell_align(&cell);
            let mut c = TableCell::new(self.inline_content(&cell, depth));
            c.colspan = (span > 1).then_some(span as u32);
            cells.push(c);
            // Each column it spans takes its alignment.
            align.extend(std::iter::repeat_n(a, span));
        }
        (cells, align)
    }

    // --- Inline content ---------------------------------------------------

    /// The content of `node` read in inline context, finished.
    fn inline_content(&mut self, node: &Handle, depth: usize) -> Vec<Inline> {
        let mut out = Vec::new();
        self.inline_children(node, &mut out, depth);
        self.finish(out)
    }

    fn inline_children(&mut self, node: &Handle, out: &mut Vec<Inline>, depth: usize) {
        if depth >= MAX_DEPTH {
            return;
        }
        for child in children(node) {
            self.inline_node(&child, out, depth + 1);
        }
    }

    /// The content of `node` read in inline context, unfinished.
    fn inline_vec(&mut self, node: &Handle, depth: usize) -> Vec<Inline> {
        let mut out = Vec::new();
        self.inline_children(node, &mut out, depth);
        out
    }

    fn inline_node(&mut self, node: &Handle, out: &mut Vec<Inline>, depth: usize) {
        let NodeData::Element { name, .. } = &node.data else {
            if let NodeData::Text { contents } = &node.data {
                push_text(out, &contents.borrow());
            }
            return;
        };
        let name = &*name.local;
        if is_hidden(node)
            || DROPPED.contains(&name)
            || self.checkbox.as_ref().is_some_and(|c| Rc::ptr_eq(c, node))
        {
            return;
        }
        if let Some(ext) = self.extension(name) {
            let mut custom = self.custom(node, ext);
            custom.content = self.inline_content(node, depth);
            out.push(Inline::Custom(custom));
            return;
        }
        let inline = match name {
            "br" => Inline::Break,
            "strong" | "b" => Inline::Strong {
                content: self.inline_vec(node, depth),
            },
            "em" | "i" | "cite" | "dfn" | "var" => Inline::Emphasis {
                content: self.inline_vec(node, depth),
            },
            "del" | "s" | "strike" => Inline::Strikethrough {
                content: self.inline_vec(node, depth),
            },
            "u" | "ins" => Inline::Underline {
                content: self.inline_vec(node, depth),
            },
            "mark" => Inline::Highlight {
                content: self.inline_vec(node, depth),
                color: mark_color(node),
            },
            "sup" => Inline::Superscript {
                content: self.inline_vec(node, depth),
            },
            "small" => Inline::Small {
                content: self.inline_vec(node, depth),
            },
            "sub" => Inline::Subscript {
                content: self.inline_vec(node, depth),
            },
            "code" | "tt" | "samp" => Inline::Code {
                code: collapsed(&text_content(node)),
            },
            "kbd" => Inline::Keyboard {
                text: collapsed(&text_content(node)).trim().to_owned(),
            },
            "a" => {
                let content = self.inline_vec(node, depth);
                match attr(node, "href").filter(|h| !h.trim().is_empty()) {
                    Some(url) => Inline::Link {
                        url: url.trim().to_owned(),
                        title: attr(node, "title"),
                        content,
                    },
                    None => {
                        out.extend(content);
                        return;
                    }
                }
            }
            "img" => match attr(node, "src").filter(|s| !s.trim().is_empty()) {
                Some(src) => {
                    let (width, height) = image_size(node);
                    Inline::Image(Image {
                        src: src.trim().to_owned(),
                        alt: attr(node, "alt").unwrap_or_default(),
                        title: attr(node, "title"),
                        width,
                        height,
                    })
                }
                None => match attr(node, "alt") {
                    Some(alt) => Inline::text(alt),
                    None => return,
                },
            },
            "q" => {
                out.push(Inline::text("\u{201c}"));
                self.inline_children(node, out, depth);
                out.push(Inline::text("\u{201d}"));
                return;
            }
            "math" => match tex_annotation(node) {
                Some(tex) => Inline::Math { tex },
                None => Inline::text(text_content(node)),
            },
            "pre" => {
                // Code in a line: its lines as breaks.
                let code = code_block(node).code;
                for (i, line) in code.split('\n').enumerate() {
                    if i > 0 {
                        out.push(Inline::Break);
                    }
                    out.push(Inline::Code {
                        code: line.to_owned(),
                    });
                }
                return;
            }
            "hr" => Inline::Break,
            _ if BLOCKS.contains(&name) => {
                // A block in inline context: its content on lines of its own.
                if !out.is_empty() && !matches!(out.last(), Some(Inline::Break)) {
                    out.push(Inline::Break);
                }
                self.inline_children(node, out, depth);
                if !matches!(out.last(), Some(Inline::Break) | None) {
                    out.push(Inline::Break);
                }
                return;
            }
            _ => {
                self.inline_children(node, out, depth);
                return;
            }
        };
        out.push(inline);
    }

    /// Inline content `inlines` as a block holds it: whitespace collapsed,
    /// line breaks at its ends dropped (a browser shows none), the pattern
    /// extensions applied.
    fn finish(&self, inlines: Vec<Inline>) -> Vec<Inline> {
        let mut ws = Whitespace {
            pending: false,
            line_start: true,
        };
        let mut inlines = collapse(inlines, &mut ws);
        while matches!(inlines.last(), Some(Inline::Break)) {
            inlines.pop();
        }
        let leading = inlines
            .iter()
            .take_while(|i| matches!(i, Inline::Break))
            .count();
        inlines.drain(..leading);
        apply_patterns(&self.parser.extensions, inlines)
    }

    // --- Extensions -------------------------------------------------------

    /// The index of the `tag` extension of elements `name`.
    fn extension(&self, name: &str) -> Option<usize> {
        self.parser.extensions.iter().position(|ext| {
            ext.tag
                .as_deref()
                .is_some_and(|tag| tag.eq_ignore_ascii_case(name))
        })
    }

    /// The custom node of element `node` of extension `ext`, without its
    /// content.
    fn custom(&self, node: &Handle, ext: usize) -> CustomNode {
        let mut custom = CustomNode::new(self.parser.extensions[ext].name.to_string());
        custom.attributes = attributes(node);
        custom.text = collapsed(&text_content(node)).trim().to_owned();
        custom
    }
}

// --- Whitespace -------------------------------------------------------------

/// Where collapsing whitespace is.
struct Whitespace {
    /// Whitespace was skipped: a space comes before the next content.
    pending: bool,
    /// At the start of a line: whitespace is dropped.
    line_start: bool,
}

/// `inlines` with whitespace collapsed as a browser collapses it (one
/// space between words, none at the start of a line or before a break),
/// adjacent texts merged and empty formatting dropped.
///
/// A skipped space is written before the content after it, so it lands
/// outside an element that ends with it (`<a>link </a>next`).
fn collapse(inlines: Vec<Inline>, ws: &mut Whitespace) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(inlines.len());
    let start_content = |out: &mut Vec<Inline>, ws: &mut Whitespace| {
        if mem::take(&mut ws.pending) {
            push_text(out, " ");
        }
        ws.line_start = false;
    };
    for inline in inlines {
        match inline {
            Inline::Text { text } => {
                let mut collapsed = String::with_capacity(text.len());
                for c in text.chars() {
                    if is_html_space(c) {
                        ws.pending |= !ws.line_start;
                    } else {
                        if mem::take(&mut ws.pending) {
                            collapsed.push(' ');
                        }
                        ws.line_start = false;
                        collapsed.push(c);
                    }
                }
                push_text(&mut out, &collapsed);
            }
            Inline::Break => {
                ws.pending = false;
                ws.line_start = true;
                out.push(Inline::Break);
            }
            Inline::Strong { content } => {
                wrap(&mut out, content, ws, |content| Inline::Strong { content })
            }
            Inline::Emphasis { content } => wrap(&mut out, content, ws, |content| {
                Inline::Emphasis { content }
            }),
            Inline::Strikethrough { content } => wrap(&mut out, content, ws, |content| {
                Inline::Strikethrough { content }
            }),
            Inline::Underline { content } => wrap(&mut out, content, ws, |content| {
                Inline::Underline { content }
            }),
            Inline::Highlight { content, color } => wrap(&mut out, content, ws, |content| {
                Inline::Highlight { content, color }
            }),
            Inline::Superscript { content } => wrap(&mut out, content, ws, |content| {
                Inline::Superscript { content }
            }),
            Inline::Subscript { content } => wrap(&mut out, content, ws, |content| {
                Inline::Subscript { content }
            }),
            Inline::Small { content } => {
                wrap(&mut out, content, ws, |content| Inline::Small { content })
            }
            Inline::Link {
                url,
                title,
                content,
            } => {
                // A link is content even when empty (an anchor to jump to).
                start_content(&mut out, ws);
                let content = collapse(content, ws);
                out.push(Inline::Link {
                    url,
                    title,
                    content,
                });
            }
            Inline::Custom(mut node) => {
                start_content(&mut out, ws);
                // Its content is its own: no space carries in or out of it.
                let mut inner = Whitespace {
                    pending: false,
                    line_start: true,
                };
                node.content = collapse(mem::take(&mut node.content), &mut inner);
                out.push(Inline::Custom(node));
            }
            Inline::Code { code } if code.is_empty() => {}
            other => {
                start_content(&mut out, ws);
                out.push(other);
            }
        }
    }
    out
}

/// `content` collapsed and wrapped by `make` into `out`, unless it is
/// empty. A space skipped before it is written before the element, not
/// inside it (`a <b>bold</b>`: the space is not bold).
fn wrap(
    out: &mut Vec<Inline>,
    content: Vec<Inline>,
    ws: &mut Whitespace,
    make: impl FnOnce(Vec<Inline>) -> Inline,
) {
    let pending = ws.pending;
    let mut content = collapse(content, ws);
    if pending
        && let Some(Inline::Text { text }) = content.first_mut()
        && text.starts_with(' ')
    {
        text.remove(0);
        if text.is_empty() {
            content.remove(0);
        }
        push_text(out, " ");
    }
    if !content.is_empty() {
        out.push(make(content));
    }
}

/// `text` after `out`, merged into a text it ends with.
fn push_text(out: &mut Vec<Inline>, text: &str) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(Inline::Text { text: last }) => last.push_str(text),
        _ => out.push(Inline::text(text)),
    }
}

/// ASCII whitespace, what HTML collapses (a no-break space is a letter).
fn is_html_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

/// `text` with each run of whitespace one space.
fn collapsed(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if is_html_space(c) {
            space = true;
        } else {
            if mem::take(&mut space) {
                out.push(' ');
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

// --- The tree ---------------------------------------------------------------

/// The children of `node` (cloned handles: reading never holds the
/// tree's borrow).
fn children(node: &Handle) -> Vec<Handle> {
    node.children.borrow().clone()
}

fn element_name(node: &Handle) -> Option<&str> {
    match &node.data {
        NodeData::Element { name, .. } => Some(&name.local),
        _ => None,
    }
}

fn attr(node: &Handle, name: &str) -> Option<String> {
    let NodeData::Element { attrs, .. } = &node.data else {
        return None;
    };
    attrs
        .borrow()
        .iter()
        .find(|a| &*a.name.local == name)
        .map(|a| a.value.to_string())
}

fn attributes(node: &Handle) -> BTreeMap<String, String> {
    let NodeData::Element { attrs, .. } = &node.data else {
        return BTreeMap::new();
    };
    attrs
        .borrow()
        .iter()
        .map(|a| (a.name.local.to_string(), a.value.to_string()))
        .collect()
}

fn has_class(node: &Handle, class: &str) -> bool {
    attr(node, "class").is_some_and(|c| c.split_ascii_whitespace().any(|c| c == class))
}

/// Whether `node` is hidden from readers (`hidden`, `aria-hidden`, an
/// inline `display: none`): KaTeX's HTML beside its MathML, icons.
fn is_hidden(node: &Handle) -> bool {
    attr(node, "hidden").is_some()
        || attr(node, "aria-hidden").is_some_and(|v| v.trim() == "true")
        || style(node, "display").is_some_and(|v| v.eq_ignore_ascii_case("none"))
}

/// The value of property `property` in `node`'s `style` attribute.
fn style(node: &Handle, property: &str) -> Option<String> {
    attr(node, "style")?.split(';').find_map(|decl| {
        let (key, value) = decl.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(property)
            .then(|| value.trim().to_owned())
    })
}

fn is_blank_text(node: &Handle) -> bool {
    match &node.data {
        NodeData::Text { contents } => contents.borrow().chars().all(is_html_space),
        NodeData::Comment { .. } => true,
        _ => false,
    }
}

/// Whether element `node` stands alone in its parent: only blocks (or
/// nothing) beside it, so it is a block itself rather than inline content.
fn is_standalone(node: &Handle) -> bool {
    let Some(parent) = node.parent.take() else {
        return true;
    };
    let parent = parent.upgrade();
    // `parent` is a `Cell<Option<Weak>>`: taken to read it, put back.
    node.parent.set(parent.as_ref().map(Rc::downgrade));
    let Some(parent) = parent else {
        return true;
    };
    let siblings = parent.children.borrow();
    let Some(at) = siblings.iter().position(|s| Rc::ptr_eq(s, node)) else {
        return true;
    };
    let is_block = |s: &Handle| element_name(s).is_some_and(|n| BLOCKS.contains(&n) || n == "br");
    let before = siblings[..at].iter().rev().find(|s| !is_blank_text(s));
    let after = siblings[at + 1..].iter().find(|s| !is_blank_text(s));
    before.is_none_or(is_block) && after.is_none_or(is_block)
}

/// Whether a descendant of `node` is a block.
fn contains_block(node: &Handle, depth: usize) -> bool {
    depth < MAX_DEPTH
        && node.children.borrow().iter().any(|c| {
            element_name(c).is_some_and(|n| BLOCKS.contains(&n)) || contains_block(c, depth + 1)
        })
}

/// The text of `node` and its descendants, `<br>` as a line break.
fn text_content(node: &Handle) -> String {
    fn walk(node: &Handle, out: &mut String, depth: usize) {
        if depth >= MAX_DEPTH {
            return;
        }
        for child in node.children.borrow().iter() {
            match &child.data {
                NodeData::Text { contents } => out.push_str(&contents.borrow()),
                NodeData::Element { name, .. } if &*name.local == "br" => out.push('\n'),
                NodeData::Element { name, .. } if DROPPED.contains(&&*name.local) => {}
                NodeData::Element { .. } => walk(child, out, depth + 1),
                _ => {}
            }
        }
    }
    let mut out = String::new();
    walk(node, &mut out, 0);
    out
}

/// `<pre>` `node` as a code block: its text as written, its language from
/// its code's class (`language-rust`, `lang-rust`) or its own.
fn code_block(node: &Handle) -> CodeBlock {
    let mut code = text_content(node);
    if code.ends_with('\n') {
        code.pop();
    }
    let language = children(node)
        .iter()
        .filter(|c| element_name(c) == Some("code"))
        .chain([node])
        .find_map(language)
        .or_else(|| attr(node, "lang").or_else(|| attr(node, "data-lang")))
        .filter(|l| !l.is_empty());
    CodeBlock::new(language, code)
}

fn language(node: &Handle) -> Option<String> {
    attr(node, "class")?
        .split_ascii_whitespace()
        .find_map(|class| {
            class
                .strip_prefix("language-")
                .or_else(|| class.strip_prefix("lang-"))
                .map(str::to_owned)
        })
}

/// The TeX of MathML `node`, from its annotation (as KaTeX and MathJax
/// write it).
fn tex_annotation(node: &Handle) -> Option<String> {
    fn find(node: &Handle, depth: usize) -> Option<Handle> {
        if depth >= MAX_DEPTH {
            return None;
        }
        children(node).into_iter().find_map(|c| {
            if element_name(&c) == Some("annotation")
                && attr(&c, "encoding").is_some_and(|e| e.eq_ignore_ascii_case("application/x-tex"))
            {
                Some(c)
            } else {
                find(&c, depth + 1)
            }
        })
    }
    Some(text_content(&find(node, 0)?).trim().to_owned())
}

/// The size `<img>` `node` asks for: its `width` and `height`
/// attributes, else those of its style (`32`, `32px`, `50%`).
fn image_size(node: &Handle) -> (Option<ImageLength>, Option<ImageLength>) {
    let length = |name: &str| {
        attr(node, name)
            .as_deref()
            .and_then(ImageLength::parse)
            .or_else(|| style(node, name).as_deref().and_then(ImageLength::parse))
    };
    (length("width"), length("height"))
}

/// The background `<mark>` `node` asks for, as a CSS color: its `color`
/// attribute, else its style's `background-color`. The `color` attribute
/// names four colors as gpui-kit's renderer does (`blue` and `yellow` are
/// Tailwind's 500 and 400, not CSS's); the rest are CSS colors.
fn mark_color(node: &Handle) -> Option<String> {
    let css = |value: &str| {
        let value = value.trim();
        value
            .parse::<nsh_core::color::Hsla>()
            .is_ok()
            .then(|| value.to_owned())
    };
    let named = |value: &str| {
        let value = value.trim();
        match value.to_ascii_lowercase().as_str() {
            "black" => Some("#000000".to_owned()),
            "white" => Some("#ffffff".to_owned()),
            "blue" => Some("#3b82f6".to_owned()),
            "yellow" => Some("#facc15".to_owned()),
            _ => css(value),
        }
    };
    attr(node, "color")
        .as_deref()
        .and_then(named)
        .or_else(|| style(node, "background-color").as_deref().and_then(css))
}

/// The alignment a cell asks for (`align`, or `text-align` in its style).
fn cell_align(node: &Handle) -> ColumnAlign {
    let value = attr(node, "align").or_else(|| style(node, "text-align"));
    match value
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("left" | "start") => ColumnAlign::Left,
        Some("center") => ColumnAlign::Center,
        Some("right" | "end") => ColumnAlign::Right,
        _ => ColumnAlign::None,
    }
}

/// The checkbox of task item `li`: an `<input type=checkbox>` before its
/// content, directly or in its first paragraph (as Markdown renderers
/// write it).
fn task_checkbox(li: &Handle) -> Option<Handle> {
    let first = |node: &Handle| children(node).into_iter().find(|c| !is_blank_text(c));
    let mut node = first(li)?;
    if element_name(&node) == Some("p") {
        node = first(&node)?;
    }
    (element_name(&node) == Some("input")
        && attr(&node, "type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox")))
    .then_some(node)
}

/// The alert of GitHub's HTML for it (`<div class="markdown-alert
/// markdown-alert-note">`).
fn alert(node: &Handle) -> Option<Alert> {
    attr(node, "class")?
        .split_ascii_whitespace()
        .find_map(|class| match class.strip_prefix("markdown-alert-")? {
            "note" => Some(Alert::Note),
            "tip" => Some(Alert::Tip),
            "important" => Some(Alert::Important),
            "warning" => Some(Alert::Warning),
            "caution" => Some(Alert::Caution),
            _ => None,
        })
}
