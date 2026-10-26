//! Markdown into a [`Document`]: `markdown-rs`'s syntax tree (CommonMark,
//! GitHub's extensions, math, front matter, MDX) read into the document
//! model, with the parser's options, declared extensions and plugins.
//!
//! The source goes through four steps: the end of a streamed reply is
//! repaired (`streaming.rs`), TeX's `\(…\)` and `\[…\]` are rewritten as
//! dollars (`latex.rs`), declared containers are cut out (`container.rs`)
//! (syntax `markdown-rs` lacks), then each Markdown part is parsed and its
//! tree converted. Definitions and footnotes are
//! collected from the trees first, so references resolve wherever they
//! stand and footnotes are numbered by their first reference.

mod container;
mod latex;
mod mapped;
pub(super) mod source;
mod streaming;
#[cfg(test)]
mod tests;

use self::mapped::Source;
use std::{
    collections::HashMap,
    ops::{Deref, Range},
};

use markdown::{
    ParseOptions,
    mdast::{self, AlignKind, AttributeContent, AttributeValue, Node},
};

use self::container::Segment;
use super::{
    Parser,
    common::{self, Slugger},
    document::{
        Alert, Block, CodeBlock, ColumnAlign, CustomNode, Document, Footnote, Image, Inline,
        ListItem, Table, TableCell, inline_text,
    },
    extension::{ParseContext, ReadChildren},
    html,
};

/// How deep blocks and inline content are read: deeper content is text.
const MAX_DEPTH: usize = 32;

/// A whole-source fallback and parsed blocks have different logical owners.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum ProjectionKind {
    LiteralWholeDocument,
    #[default]
    Parsed,
}

/// One native publication: the document and the ranges of its actual root rows.
/// This is not part of the app-authored document or the JS document format.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Projection {
    pub(super) document: Document,
    pub(super) kind: ProjectionKind,
    /// Original UTF-8 bytes captured by this parse, before lexical repair.
    pub(super) raw_len: u64,
    /// One interval set per block, then one for the combined footnotes row.
    pub(super) rows: std::sync::Arc<[Vec<Range<u64>>]>,
}
impl Deref for Projection {
    type Target = Document;

    fn deref(&self) -> &Document {
        &self.document
    }
}

/// Markdown `source` read with `parser`'s options, extensions and plugins.
pub(super) fn parse(parser: &Parser, source: &str, mapped: bool) -> Projection {
    let raw_len = source.len() as u64;
    let mut source = Source::original(source).normalize();
    if parser.options.streaming {
        source = streaming::repair_mapped(source);
    }
    if parser.options.math {
        source = latex::rewrite_mapped(source);
    }

    let segments = if parser.extensions.iter().any(|e| e.container.is_some()) {
        container::split(&source, &parser.extensions)
    } else {
        vec![Segment::Markdown(0..source.len())]
    };
    let mut trees = Vec::new();
    parse_trees(parser, &source, &segments, &mut trees);
    // `markdown-rs` resolves a reference only to a definition of the same
    // parse: parts a container cut apart are read again with the
    // document's definitions after them.
    if trees.len() > 1 {
        let definitions = definitions(&trees);
        if !definitions.is_empty() {
            let mut ranges = Vec::new();
            markdown_ranges(&segments, &mut ranges);
            trees = ranges
                .iter()
                .map(|r| {
                    let mut text = source.slice(r.clone());
                    text.push("\n\n");
                    text.append(&definitions);
                    tree(parser, text, r.start == 0)
                })
                .collect();
        }
    }

    if trees.is_empty() {
        trees.push(tree(parser, Source::default(), true));
    }
    let mut converter = Converter::new(parser, &source, &trees, mapped);
    let mut blocks = Vec::new();
    let mut rows = Vec::new();
    let mut next = 0;
    converter.segments(
        &segments,
        &trees,
        &mut next,
        &mut blocks,
        mapped.then_some(&mut rows),
    );
    let (footnotes, footnote_ranges) = converter.footnotes();
    if mapped && !footnotes.is_empty() {
        rows.push(footnote_ranges);
    }
    Projection {
        document: Document { blocks, footnotes },
        kind: ProjectionKind::Parsed,
        raw_len,
        rows: rows.into(),
    }
}

/// A Markdown part of the source and its syntax tree.
struct Tree {
    source: Source,
    root: Node,
}

fn parse_trees(parser: &Parser, source: &Source, segments: &[Segment], out: &mut Vec<Tree>) {
    for segment in segments {
        match segment {
            Segment::Markdown(range) => {
                // Front matter is only the document's first lines.
                out.push(tree(parser, source.slice(range.clone()), range.start == 0));
            }
            Segment::Container(container) => parse_trees(parser, source, &container.children, out),
        }
    }
}

/// Markdown `text` parsed (`first`: the document's start).
fn tree(parser: &Parser, mut source: Source, first: bool) -> Tree {
    let mut root = parse_tree(parser, &source, first);
    if parser.options.math {
        // Pairs of `$` that are prose: their opening `$` escaped, the text
        // is read again, as a whole (emphasis may span the pair); a
        // closing `$` may pair with a later one, so again until none is.
        for _ in 0..16 {
            let mut opens = Vec::new();
            prose_math(&root, &source, &mut opens);
            if opens.is_empty() {
                break;
            }
            let mut escaped = source.writer();
            let mut at = 0;
            for open in opens {
                escaped.copy(&source[at..open]);
                escaped.push('\\');
                at = open;
            }
            escaped.copy(&source[at..]);
            source = escaped.finish();
            root = parse_tree(parser, &source, first);
        }
    }
    Tree { source, root }
}

/// The ranges of the Markdown parts of `segments`, in order.
fn markdown_ranges(segments: &[Segment], out: &mut Vec<std::ops::Range<usize>>) {
    for segment in segments {
        match segment {
            Segment::Markdown(range) => out.push(range.clone()),
            Segment::Container(container) => markdown_ranges(&container.children, out),
        }
    }
}

/// The source of the link and footnote definitions of `trees` (their top
/// level), each on lines of its own.
fn definitions(trees: &[Tree]) -> Source {
    let mut out = Source::default();
    for tree in trees {
        let Some(children) = tree.root.children() else {
            continue;
        };
        for node in children {
            if matches!(node, Node::Definition(_) | Node::FootnoteDefinition(_))
                && let Some(p) = node.position()
                && tree.source.get(p.start.offset..p.end.offset).is_some()
            {
                out.append(&tree.source.slice(p.start.offset..p.end.offset));
                out.push("\n\n");
            }
        }
    }
    out
}

fn parse_tree(parser: &Parser, text: &str, first: bool) -> Node {
    let mdx = parser.options.mdx;
    match markdown::to_mdast(text, &options(parser, first, mdx)) {
        Ok(root) => root,
        // Only MDX fails (JSX not closed yet, a stray `{`): the text is
        // then read as Markdown.
        Err(err) => {
            log::debug!("TextView: MDX not read ({err}), read as Markdown");
            markdown::to_mdast(text, &options(parser, first, false)).unwrap_or_else(|_| {
                Node::Root(mdast::Root {
                    children: vec![Node::Paragraph(mdast::Paragraph {
                        children: vec![Node::Text(mdast::Text {
                            value: text.to_owned(),
                            position: None,
                        })],
                        position: None,
                    })],
                    position: None,
                })
            })
        }
    }
}

/// `markdown-rs`'s options for `parser`'s.
fn options(parser: &Parser, frontmatter: bool, mdx: bool) -> ParseOptions {
    let opts = &parser.options;
    let mut options = ParseOptions::gfm();
    let c = &mut options.constructs;
    c.math_text = opts.math;
    c.math_flow = opts.math;
    c.frontmatter = frontmatter && opts.frontmatter;
    if mdx {
        // As `Constructs::mdx()`, without ESM (no parser for it here).
        c.autolink = false;
        c.code_indented = false;
        c.html_flow = false;
        c.html_text = false;
        c.mdx_expression_flow = true;
        c.mdx_expression_text = true;
        c.mdx_jsx_flow = true;
        c.mdx_jsx_text = true;
    }
    for plugin in &parser.plugins.0 {
        plugin.configure(&mut options);
    }
    options
}

/// Formulas that are prose: `markdown-rs` pairs any two `$`, so "costs $5
/// and $10" holds a formula `5 and `. As Pandoc decides, a single `$`
/// opens a formula only before a non-space and closes one only after a
/// non-space not followed by a digit: the offsets of the opening `$` of
/// the other pairs go into `opens`, in order.
fn prose_math(node: &Node, source: &str, opens: &mut Vec<usize>) {
    prose_math_at(node, source, opens, 0);
}

fn prose_math_at(node: &Node, source: &str, opens: &mut Vec<usize>, depth: usize) {
    if depth >= MAX_DEPTH * 2 {
        return;
    }
    if let Node::InlineMath(math) = node
        && let Some(position) = &math.position
        && is_prose(
            source,
            &math.value,
            position.start.offset,
            position.end.offset,
        )
    {
        opens.push(position.start.offset);
        return;
    }
    for child in node.children().into_iter().flatten() {
        prose_math_at(child, source, opens, depth + 1);
    }
}

fn is_prose(source: &str, tex: &str, start: usize, end: usize) -> bool {
    let Some(literal) = source.get(start..end) else {
        return false;
    };
    if literal.starts_with("$$") {
        return false;
    }
    tex.starts_with(char::is_whitespace)
        || tex.ends_with(char::is_whitespace)
        || source[end..].starts_with(|c: char| c.is_ascii_digit())
}

/// Reads the trees into the document.
struct Converter<'a> {
    parser: &'a Parser,
    /// The source of the tree being read.
    source: &'a Source,
    /// The complete rewritten source, before container slices and appended definitions.
    document_source: &'a Source,
    mapped: bool,
    quote: u32,
    /// Link and image definitions by identifier.
    definitions: HashMap<&'a str, &'a mdast::Definition>,
    /// Footnote definitions by identifier, with the source of their tree.
    footnote_definitions: HashMap<&'a str, (&'a Source, &'a mdast::FootnoteDefinition)>,
    /// Identifiers of the footnotes referred to, in the order of their
    /// first reference.
    footnote_order: Vec<&'a str>,
    footnote_index: HashMap<&'a str, u32>,
    slugger: Slugger,
    /// How deep the reading is.
    depth: usize,
}

impl<'a> Converter<'a> {
    fn new(
        parser: &'a Parser,
        document_source: &'a Source,
        trees: &'a [Tree],
        mapped: bool,
    ) -> Self {
        let mut converter = Self {
            parser,
            source: &trees[0].source,
            document_source,
            mapped,
            quote: 0,
            definitions: HashMap::new(),
            footnote_definitions: HashMap::new(),
            footnote_order: Vec::new(),
            footnote_index: HashMap::new(),
            slugger: Slugger::default(),
            depth: 0,
        };
        for tree in trees {
            converter.collect(&tree.source, &tree.root);
        }
        converter
    }

    /// Collects the definitions under `node` (the first of a name wins).
    fn collect(&mut self, source: &'a Source, node: &'a Node) {
        self.collect_at(source, node, 0);
    }

    fn collect_at(&mut self, source: &'a Source, node: &'a Node, depth: usize) {
        if depth >= MAX_DEPTH {
            return;
        }
        match node {
            Node::Definition(def) => {
                self.definitions.entry(&def.identifier).or_insert(def);
            }
            Node::FootnoteDefinition(def) => {
                self.footnote_definitions
                    .entry(&def.identifier)
                    .or_insert((source, def));
                for child in &def.children {
                    self.collect_at(source, child, depth + 1);
                }
            }
            Node::Root(_)
            | Node::Blockquote(_)
            | Node::List(_)
            | Node::ListItem(_)
            | Node::MdxJsxFlowElement(_) => {
                for child in node.children().into_iter().flatten() {
                    self.collect_at(source, child, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn segments(
        &mut self,
        segments: &[Segment],
        trees: &'a [Tree],
        next: &mut usize,
        out: &mut Vec<Block>,
        mut rows: Option<&mut Vec<Vec<Range<u64>>>>,
    ) {
        for segment in segments {
            match segment {
                Segment::Markdown(_) => {
                    let tree = &trees[*next];
                    *next += 1;
                    self.source = &tree.source;
                    if let Some(children) = tree.root.children() {
                        self.blocks_with_rows(children, out, rows.as_deref_mut());
                    }
                }
                Segment::Container(container) => {
                    let mut children = Vec::new();
                    self.segments(&container.children, trees, next, &mut children, None);
                    if let Some(rows) = rows.as_deref_mut() {
                        rows.push(self.document_source.ranges(container.range.clone()));
                    }
                    out.push(Block::Custom(CustomNode {
                        name: container.name.clone(),
                        attributes: container.attributes.clone(),
                        children,
                        ..CustomNode::default()
                    }));
                }
            }
        }
    }

    /// The footnotes referred to, numbered; those their own text refers to
    /// come after.
    fn footnotes(&mut self) -> (Vec<Footnote>, Vec<Range<u64>>) {
        let mut footnotes = Vec::new();
        let mut ranges = Vec::new();
        let mut i = 0;
        while let Some(&id) = self.footnote_order.get(i) {
            i += 1;
            let Some(&(source, def)) = self.footnote_definitions.get(id) else {
                continue;
            };
            self.source = source;
            if self.mapped
                && let Some(position) = &def.position
            {
                ranges.extend(source.ranges(position.start.offset..position.end.offset));
            }
            let mut children = Vec::new();
            self.blocks_into(&def.children, &mut children);
            footnotes.push(Footnote {
                label: def.label.clone().unwrap_or_else(|| def.identifier.clone()),
                index: i as u32,
                children,
            });
        }
        mapped::merge_ranges(&mut ranges);
        (footnotes, ranges)
    }

    /// A context for plugins reading with this converter.
    fn offer_block(&mut self, node: &Node) -> Option<Block> {
        let parser = self.parser;
        if parser.plugins.is_empty() {
            return None;
        }
        let source = self.source;
        let mut cx = ParseContext {
            source,
            reader: self,
        };
        parser.plugins.0.iter().find_map(|p| p.block(node, &mut cx))
    }

    fn offer_inline(&mut self, node: &Node) -> Option<Inline> {
        let parser = self.parser;
        if parser.plugins.is_empty() {
            return None;
        }
        let source = self.source;
        let mut cx = ParseContext {
            source,
            reader: self,
        };
        parser
            .plugins
            .0
            .iter()
            .find_map(|p| p.inline(node, &mut cx))
    }

    // --- Blocks -------------------------------------------------------------

    fn blocks_into(&mut self, nodes: &[Node], out: &mut Vec<Block>) {
        self.blocks_with_rows(nodes, out, None);
    }

    fn blocks_with_rows(
        &mut self,
        nodes: &[Node],
        out: &mut Vec<Block>,
        rows: Option<&mut Vec<Vec<Range<u64>>>>,
    ) {
        // The tree is read recursively, as it is shown: deeper content is
        // its text, so no input runs the stack out.
        if self.depth >= MAX_DEPTH {
            let text: String = nodes.iter().map(Node::to_string).collect();
            if !text.trim().is_empty() {
                out.push(Block::Paragraph {
                    content: vec![Inline::Text { text }],
                });
                if let Some(rows) = rows {
                    let mut ranges = nodes
                        .iter()
                        .flat_map(|node| self.source.ranges(node_range(node)))
                        .collect();
                    mapped::merge_ranges(&mut ranges);
                    rows.push(ranges);
                }
            }
            return;
        }
        self.depth += 1;
        self.read_blocks(nodes, out, rows);
        self.depth -= 1;
    }

    fn read_blocks(
        &mut self,
        nodes: &[Node],
        out: &mut Vec<Block>,
        mut rows: Option<&mut Vec<Vec<Range<u64>>>>,
    ) {
        let mut i = 0;
        while i < nodes.len() {
            let first = i;
            let before = out.len();
            if let Some(block) = self.offer_block(&nodes[i]) {
                out.push(block);
            } else if let Some(close) = self.html_element(nodes, i, out) {
                i = close;
            } else if rows.is_some()
                && matches!(
                    &nodes[i],
                    Node::Root(_)
                        | Node::MdxJsxFlowElement(mdast::MdxJsxFlowElement { name: None, .. })
                )
            {
                // Fragments expose their children as separate root rows.
                self.blocks_with_rows(
                    nodes[i].children().map_or(&[][..], Vec::as_slice),
                    out,
                    rows.as_deref_mut(),
                );
                i += 1;
                continue;
            } else {
                self.convert_block(&nodes[i], out);
            }
            if let Some(rows) = rows.as_deref_mut() {
                let mut ranges = Vec::new();
                for node in &nodes[first..=i] {
                    ranges.extend(self.source.ranges(node_range(node)));
                }
                mapped::merge_ranges(&mut ranges);
                rows.extend((before..out.len()).map(|_| ranges.clone()));
            }
            i += 1;
        }
    }

    fn block(&mut self, node: &Node, out: &mut Vec<Block>) {
        self.blocks_into(std::slice::from_ref(node), out);
    }

    fn convert_block(&mut self, node: &Node, out: &mut Vec<Block>) {
        match node {
            Node::Root(root) => self.blocks_into(&root.children, out),
            Node::Paragraph(p) => {
                let content = self.content(&p.children);
                if !is_blank(&content) {
                    out.push(Block::Paragraph { content });
                }
            }
            Node::Heading(h) => {
                let content = self.content(&h.children);
                let slug = self.slugger.slug(&inlines_text(&content));
                out.push(Block::Heading {
                    level: h.depth.clamp(1, 6),
                    content,
                    anchor: (!slug.is_empty()).then_some(slug),
                });
            }
            Node::Blockquote(quote) => {
                self.quote += 1;
                let alert = self
                    .parser
                    .options
                    .alerts
                    .then(|| alert(&quote.children, self.source, self.quote))
                    .flatten();
                let mut children = Vec::new();
                let alert = match alert {
                    Some((alert, first)) => {
                        if let Some(first) = first {
                            self.block(&first, &mut children);
                        }
                        self.blocks_into(&quote.children[1..], &mut children);
                        Some(alert)
                    }
                    None => {
                        self.blocks_into(&quote.children, &mut children);
                        None
                    }
                };
                self.quote -= 1;
                out.push(Block::Blockquote { children, alert });
            }
            Node::List(list) => {
                let mut loose = list.spread;
                let items = list
                    .children
                    .iter()
                    .filter_map(|item| {
                        let Node::ListItem(item) = item else {
                            return None;
                        };
                        loose |= item.spread;
                        let mut children = Vec::new();
                        self.blocks_into(&item.children, &mut children);
                        Some(ListItem {
                            checked: item.checked,
                            children,
                        })
                    })
                    .collect();
                out.push(Block::List {
                    ordered: list.ordered,
                    start: list.start.unwrap_or(1),
                    loose,
                    items,
                });
            }
            Node::Code(code) => out.push(self.code(code)),
            Node::Math(math) => out.push(Block::Math {
                tex: math.value.clone(),
                source: self.formula_source(node, &math.value),
            }),
            Node::Html(h) => {
                if self.parser.options.html {
                    let mut blocks = html::blocks(self.parser, &h.value);
                    self.html_blocks(&mut blocks, node_range(node));
                    out.extend(blocks);
                } else {
                    out.push(Block::Paragraph {
                        content: self.source_content(
                            literal_lines(&h.value),
                            node_range(node),
                            &h.value,
                        ),
                    });
                }
            }
            Node::ThematicBreak(_) => out.push(Block::Rule),
            Node::Table(table) => out.push(self.table(table)),
            Node::Yaml(yaml) => out.push(Block::Custom(
                CustomNode::new("frontmatter").with_text(&yaml.value),
            )),
            Node::Toml(toml) => out.push(Block::Custom(
                CustomNode::new("frontmatter")
                    .with_text(&toml.value)
                    .with_attribute("format", "toml"),
            )),
            Node::MdxJsxFlowElement(el) => {
                let mut children = Vec::new();
                self.blocks_into(&el.children, &mut children);
                match &el.name {
                    Some(name) => {
                        let mut node = self.jsx(name, &el.attributes);
                        node.text = blocks_text(&children);
                        node.children = children;
                        out.push(Block::Custom(node));
                    }
                    // A fragment (`<>…</>`) is its content.
                    None => out.extend(children),
                }
            }
            Node::MdxFlowExpression(expr) => out.push(Block::Custom(
                CustomNode::new("expression").with_text(&expr.value),
            )),
            // Collected beforehand; ESM is not read.
            Node::Definition(_) | Node::FootnoteDefinition(_) | Node::MdxjsEsm(_) => {}
            // Inline nodes where blocks go (from a plugin's reading): a
            // paragraph of them.
            other => {
                let content = self.content(std::slice::from_ref(other));
                if !is_blank(&content) {
                    out.push(Block::Paragraph { content });
                }
            }
        }
    }

    fn code(&mut self, code: &mdast::Code) -> Block {
        if let Some(lang) = &code.lang {
            let ext = self.parser.extensions.iter().find(|e| {
                e.language
                    .as_deref()
                    .is_some_and(|l| l.eq_ignore_ascii_case(lang))
            });
            if let Some(ext) = ext {
                let mut node = CustomNode::new(ext.name.as_ref()).with_text(&code.value);
                if let Some(meta) = &code.meta {
                    node = node.with_attribute("meta", meta);
                }
                return Block::Custom(node);
            }
            // GitHub shows fences of `math` as formulas.
            if self.parser.options.math && lang.eq_ignore_ascii_case("math") {
                return Block::Math {
                    tex: code.value.clone(),
                    source: self.code_source(&Node::Code(code.clone()), &code.value),
                };
            }
        }
        Block::CodeBlock(CodeBlock {
            language: code.lang.clone(),
            meta: code.meta.clone(),
            code: code.value.clone(),
            source: self.code_source(&Node::Code(code.clone()), &code.value),
        })
    }

    fn table(&mut self, table: &mdast::Table) -> Block {
        let mut rows = table.children.iter().filter_map(|row| match row {
            Node::TableRow(row) => Some(row),
            _ => None,
        });
        let head: Vec<TableCell> = rows.next().map(|r| self.row(r)).unwrap_or_default();
        let width = head.len();
        let rows = rows
            .map(|row| {
                let mut cells = self.row(row);
                cells.resize_with(width, TableCell::default);
                cells
            })
            .collect();
        Block::Table(Table {
            align: table
                .align
                .iter()
                .map(|a| match a {
                    AlignKind::Left => ColumnAlign::Left,
                    AlignKind::Center => ColumnAlign::Center,
                    AlignKind::Right => ColumnAlign::Right,
                    AlignKind::None => ColumnAlign::None,
                })
                .collect(),
            head,
            rows,
        })
    }

    fn row(&mut self, row: &mdast::TableRow) -> Vec<TableCell> {
        row.children
            .iter()
            .map(|cell| {
                TableCell::new(self.content(cell.children().map_or(&[][..], Vec::as_slice)))
            })
            .collect()
    }

    /// An HTML element whose opening and closing tags are blocks of their
    /// own with Markdown between them (`<details>`, a blank line, Markdown,
    /// `</details>`): read as one element holding the Markdown's blocks.
    /// Returns the index of its closing tag.
    fn html_element(&mut self, nodes: &[Node], at: usize, out: &mut Vec<Block>) -> Option<usize> {
        if !self.parser.options.html {
            return None;
        }
        let Node::Html(open) = &nodes[at] else {
            return None;
        };
        let name = unclosed_element(&open.value)?;
        let close = matching_close(nodes, at, name)?;
        let Node::Html(close_node) = &nodes[close] else {
            return None;
        };
        let mut element = html::blocks(
            self.parser,
            &format!("{}\n{}", open.value, close_node.value.trim()),
        );
        self.html_blocks(&mut element, node_range(&nodes[at]));
        let children = match element.last_mut() {
            Some(Block::Details { children, .. })
            | Some(Block::Blockquote { children, .. })
            | Some(Block::Custom(CustomNode { children, .. })) => children,
            _ => return None,
        };
        let mut inner = Vec::new();
        self.blocks_into(&nodes[at + 1..close], &mut inner);
        children.extend(inner);
        if let Some(Block::Custom(node)) = element.last_mut()
            && node.content.is_empty()
        {
            node.text = blocks_text(&node.children);
        }
        out.extend(element);
        Some(close)
    }

    fn formula_source(&self, node: &Node, text: &str) -> Vec<nsh_core::TextSourceSegment> {
        let range = node_range(node);
        let raw = self.source.get(range.clone()).unwrap_or_default();
        // A formula with fences on their own lines keeps its body exactly as
        // code does. Same-line math is one lexical delimiter replacement.
        if raw.contains('\n')
            && raw
                .lines()
                .next()
                .unwrap_or_default()
                .trim_matches(['$', ' ', '\t', '\r'])
                .is_empty()
        {
            self.code_source(node, text)
        } else {
            self.source_segments(range, text, false)
        }
    }

    fn code_source(&self, node: &Node, text: &str) -> Vec<nsh_core::TextSourceSegment> {
        if !self.mapped {
            return Vec::new();
        }
        self.source.project(
            text,
            source::code(self.source, node, text).expect("Markdown code/formula provenance"),
        )
    }

    /// A literal source range is exact only when its visible bytes agree.
    /// HTML's decoded/collapsed text is an explicit atomic replacement of
    /// the originating HTML node, never a guessed substring address.
    fn source_segments(
        &self,
        range: std::ops::Range<usize>,
        text: &str,
        literal: bool,
    ) -> Vec<nsh_core::TextSourceSegment> {
        if !self.mapped || text.is_empty() {
            return Vec::new();
        }
        let segments = if literal && self.source.get(range.clone()) == Some(text) {
            source::literal(range.start, text)
        } else {
            vec![nsh_core::TextSourceSegment {
                start: 0,
                end: text.encode_utf16().count() as u32,
                source_start: range.start as u64,
                source_end: range.end as u64,
                kind: nsh_core::TextSourceKind::Replacement,
            }]
        };
        self.source.project(text, segments)
    }

    fn source_content(
        &self,
        content: Vec<Inline>,
        range: std::ops::Range<usize>,
        text: &str,
    ) -> Vec<Inline> {
        if !self.mapped {
            return content;
        }
        vec![Inline::Source {
            content,
            segments: self.source_segments(range, text, true),
        }]
    }

    fn html_inlines(&self, content: &mut [Inline], range: std::ops::Range<usize>) {
        if !self.mapped {
            return;
        }
        for inline in content {
            match inline {
                Inline::Source { .. } => {}
                Inline::Strong { content }
                | Inline::Emphasis { content }
                | Inline::Strikethrough { content }
                | Inline::Underline { content }
                | Inline::Highlight { content, .. }
                | Inline::Superscript { content }
                | Inline::Subscript { content }
                | Inline::Small { content }
                | Inline::Link { content, .. } => self.html_inlines(content, range.clone()),
                Inline::Custom(node) => {
                    self.html_blocks(&mut node.children, range.clone());
                    self.html_inlines(&mut node.content, range.clone());
                    node.source = self.source_segments(range.clone(), &node.text, false);
                }
                leaf => {
                    let text = match &*leaf {
                        Inline::Image(_) => "\u{fffc}".into(),
                        Inline::FootnoteReference { index, .. } => index.to_string(),
                        leaf => leaf.plain_text(),
                    };
                    let segments = self.source_segments(range.clone(), &text, false);
                    let original = std::mem::replace(leaf, Inline::text(""));
                    *leaf = Inline::Source {
                        content: vec![original],
                        segments,
                    };
                }
            }
        }
    }

    fn html_blocks(&self, blocks: &mut [Block], range: std::ops::Range<usize>) {
        if !self.mapped {
            return;
        }
        for block in blocks {
            match block {
                Block::Paragraph { content } | Block::Heading { content, .. } => {
                    self.html_inlines(content, range.clone())
                }
                Block::Blockquote { children, .. } => self.html_blocks(children, range.clone()),
                Block::List { items, .. } => {
                    for item in items {
                        self.html_blocks(&mut item.children, range.clone());
                    }
                }
                Block::CodeBlock(code) => {
                    code.source = self.source_segments(range.clone(), &code.code, false)
                }
                Block::Math { tex, source } => {
                    *source = self.source_segments(range.clone(), tex, false)
                }
                Block::Table(table) => {
                    for cell in table.head.iter_mut().chain(table.rows.iter_mut().flatten()) {
                        self.html_inlines(&mut cell.content, range.clone());
                    }
                }
                Block::Details {
                    summary, children, ..
                } => {
                    self.html_inlines(summary, range.clone());
                    self.html_blocks(children, range.clone());
                }
                Block::Custom(node) => {
                    self.html_inlines(&mut node.content, range.clone());
                    self.html_blocks(&mut node.children, range.clone());
                    node.source = self.source_segments(range.clone(), &node.text, false);
                }
                Block::Rule => {}
            }
        }
    }

    // --- Inline content -----------------------------------------------------

    /// The inline content of a block: patterns applied.
    fn content(&mut self, nodes: &[Node]) -> Vec<Inline> {
        let content = self.inlines(nodes);
        common::apply_patterns(&self.parser.extensions, content)
    }

    fn inlines(&mut self, nodes: &[Node]) -> Vec<Inline> {
        if self.depth >= MAX_DEPTH {
            let text: String = nodes.iter().map(Node::to_string).collect();
            return vec![Inline::Text { text }];
        }
        self.depth += 1;
        let out = self.read_inlines(nodes);
        self.depth -= 1;
        out
    }

    fn read_inlines(&mut self, nodes: &[Node]) -> Vec<Inline> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < nodes.len() {
            let node = &nodes[i];
            if let Some(inline) = self.offer_inline(node) {
                push(&mut out, inline);
            } else if let Some((close, fragment)) = self.inline_element(nodes, i) {
                match self.formatting_element(nodes, i, close) {
                    Some(inline) => out.push(inline),
                    None => {
                        let mut content = html::inlines(self.parser, fragment);
                        let range = node_range(&nodes[i]).start..node_range(&nodes[close]).end;
                        self.html_inlines(&mut content, range);
                        extend(&mut out, content);
                    }
                }
                i = close;
            } else {
                self.convert_inline(node, &mut out);
            }
            i += 1;
        }
        out
    }

    /// An HTML element in text, `<b>x</b>`: its tags are nodes of their
    /// own, so the source from its opening tag to its closing tag is read
    /// as one fragment. Returns the index of the closing tag.
    fn inline_element(&self, nodes: &[Node], at: usize) -> Option<(usize, &'a str)> {
        let Node::Html(open) = &nodes[at] else {
            return None;
        };
        if !self.parser.options.html {
            return None;
        }
        let name = unclosed_element(&open.value)?;
        let close = matching_close(nodes, at, name)?;
        let start = nodes[at].position()?.start.offset;
        let end = nodes[close].position()?.end.offset;
        Some((close, self.source.get(start..end)?))
    }

    /// A formatting element in text whose content is Markdown
    /// (`<strong>b *c*</strong>`: `c` is emphasized), as gpui-kit pairs
    /// formatting tags: the element as HTML reads its opening tag (a
    /// `<mark>`'s color, a link's URL), holding the Markdown between its
    /// tags. `None` for other elements, read as HTML.
    fn formatting_element(&mut self, nodes: &[Node], open: usize, close: usize) -> Option<Inline> {
        /// Stands for the content while the opening tag is read.
        const CONTENT: &str = "\u{e000}";
        const FORMATTING: &[&str] = &[
            "a", "b", "cite", "del", "dfn", "em", "i", "ins", "mark", "s", "small", "strike",
            "strong", "sub", "sup", "u", "var",
        ];
        let Node::Html(tag) = &nodes[open] else {
            return None;
        };
        let name = unclosed_element(&tag.value)?.to_ascii_lowercase();
        if !FORMATTING.contains(&name.as_str()) {
            return None;
        }
        let read = html::inlines(self.parser, &format!("{}{CONTENT}</{name}>", tag.value));
        let [mut element] = <[Inline; 1]>::try_from(read).ok()?;
        let slot = match &mut element {
            Inline::Strong { content }
            | Inline::Emphasis { content }
            | Inline::Strikethrough { content }
            | Inline::Underline { content }
            | Inline::Highlight { content, .. }
            | Inline::Superscript { content }
            | Inline::Subscript { content }
            | Inline::Small { content }
            | Inline::Link { content, .. } => content,
            _ => return None,
        };
        if !matches!(slot.as_slice(), [Inline::Text { text }] if text == CONTENT) {
            return None;
        }
        *slot = self.inlines(&nodes[open + 1..close]);
        Some(element)
    }

    fn convert_inline(&mut self, node: &Node, out: &mut Vec<Inline>) {
        let begin = out.len();
        match node {
            Node::Text(text) => {
                let text = if self.parser.options.preserve_line_breaks {
                    text.value.clone()
                } else {
                    text.value.replace('\n', " ")
                };
                if self.mapped {
                    out.push(Inline::text(text));
                } else {
                    push_text(out, &text);
                }
            }
            Node::Emphasis(e) => out.push(Inline::Emphasis {
                content: self.inlines(&e.children),
            }),
            Node::Strong(s) => out.push(Inline::Strong {
                content: self.inlines(&s.children),
            }),
            Node::Delete(d) => out.push(Inline::Strikethrough {
                content: self.inlines(&d.children),
            }),
            Node::InlineCode(code) => out.push(Inline::Code {
                code: code.value.clone(),
            }),
            Node::InlineMath(math) => out.push(Inline::Math {
                tex: math.value.clone(),
            }),
            Node::Break(_) => out.push(Inline::Break),
            Node::Link(link) => out.push(Inline::Link {
                url: link.url.clone(),
                title: link.title.clone(),
                content: self.inlines(&link.children),
            }),
            Node::LinkReference(link) => {
                let content = self.inlines(&link.children);
                match self.definitions.get(link.identifier.as_str()) {
                    Some(def) => out.push(Inline::Link {
                        url: def.url.clone(),
                        title: def.title.clone(),
                        content,
                    }),
                    None => self.literal(node, out),
                }
            }
            Node::Image(image) => out.push(Inline::Image(Image {
                src: image.url.clone(),
                alt: image.alt.clone(),
                title: image.title.clone(),
                ..Image::default()
            })),
            Node::ImageReference(image) => match self.definitions.get(image.identifier.as_str()) {
                Some(def) => out.push(Inline::Image(Image {
                    src: def.url.clone(),
                    alt: image.alt.clone(),
                    title: def.title.clone(),
                    ..Image::default()
                })),
                None => self.literal(node, out),
            },
            Node::FootnoteReference(note) => {
                let Some((&id, _)) = self
                    .footnote_definitions
                    .get_key_value(note.identifier.as_str())
                else {
                    return self.literal(node, out);
                };
                let index = match self.footnote_index.get(id) {
                    Some(&index) => index,
                    None => {
                        self.footnote_order.push(id);
                        let index = self.footnote_order.len() as u32;
                        self.footnote_index.insert(id, index);
                        index
                    }
                };
                out.push(Inline::FootnoteReference {
                    label: note
                        .label
                        .clone()
                        .unwrap_or_else(|| note.identifier.clone()),
                    index,
                });
            }
            Node::Html(h) => {
                if self.parser.options.html {
                    let mut content = html::inlines(self.parser, &h.value);
                    self.html_inlines(&mut content, node_range(node));
                    extend(out, content);
                } else {
                    let text = h.value.replace('\n', " ");
                    let content = self.source_content(
                        vec![Inline::text(text.clone())],
                        node_range(node),
                        &text,
                    );
                    extend(out, content);
                }
            }
            Node::MdxJsxTextElement(el) => {
                let content = self.inlines(&el.children);
                match &el.name {
                    Some(name) => {
                        let mut node = self.jsx(name, &el.attributes);
                        node.text = inlines_text(&content);
                        node.content = content;
                        out.push(Inline::Custom(node));
                    }
                    None => extend(out, content),
                }
            }
            Node::MdxTextExpression(expr) => out.push(Inline::Custom(
                CustomNode::new("expression").with_text(&expr.value),
            )),
            // Blocks where inline content goes: their text.
            other => {
                if let Some(children) = other.children() {
                    let content = self.inlines(children);
                    extend(out, content);
                }
            }
        }
        if self.mapped
            && matches!(
                node,
                Node::Text(_)
                    | Node::InlineCode(_)
                    | Node::InlineMath(_)
                    | Node::Break(_)
                    | Node::Image(_)
                    | Node::ImageReference(_)
            )
            && out.len() > begin
        {
            let content = out.split_off(begin);
            let image = matches!(content.as_slice(), [Inline::Image(_)]);
            let rendered = if image {
                "\u{fffc}".to_owned()
            } else {
                inlines_text(&content)
            };
            let segments = match node {
                Node::Text(_) => source::text(self.source, node, &rendered, self.quote),
                Node::InlineCode(_) => {
                    source::inline_code(self.source, node, &rendered, self.quote)
                }
                Node::Break(_) => Ok(source::line_break(self.source, node)),
                _ => Ok(vec![nsh_core::TextSourceSegment {
                    start: 0,
                    end: rendered.encode_utf16().count() as u32,
                    source_start: node.position().map_or(0, |p| p.start.offset) as u64,
                    source_end: node.position().map_or(0, |p| p.end.offset) as u64,
                    kind: nsh_core::TextSourceKind::Replacement,
                }]),
            }
            .expect("Markdown inline provenance");
            out.push(Inline::Source {
                content,
                segments: self.source.project(&rendered, segments),
            });
        }
    }

    /// Node `node` as the text it was written as.
    fn literal(&mut self, node: &Node, out: &mut Vec<Inline>) {
        let text = node
            .position()
            .and_then(|p| self.source.get(p.start.offset..p.end.offset))
            .map(|s| s.replace('\n', " "))
            .unwrap_or_else(|| node.to_string());
        push_text(out, &text);
    }

    /// The custom node of a JSX element `name`: named by the extension
    /// declaring its tag, else by the tag.
    fn jsx(&self, name: &str, attributes: &[AttributeContent]) -> CustomNode {
        let ext = self.parser.extensions.iter().find(|e| {
            e.tag
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case(name))
        });
        let mut node = CustomNode::new(ext.map_or(name, |e| e.name.as_ref()));
        for attribute in attributes {
            // `{...spread}` names no attribute.
            let AttributeContent::Property(property) = attribute else {
                continue;
            };
            let value = match &property.value {
                None => "true".to_owned(),
                Some(AttributeValue::Literal(value)) => value.clone(),
                Some(AttributeValue::Expression(expr)) => expr.value.clone(),
            };
            node.attributes.insert(property.name.clone(), value);
        }
        node
    }
}

impl ReadChildren for Converter<'_> {
    fn blocks(&mut self, _source: &str, nodes: &[Node]) -> Vec<Block> {
        let mut out = Vec::new();
        self.blocks_into(nodes, &mut out);
        out
    }

    fn inlines(&mut self, _source: &str, nodes: &[Node]) -> Vec<Inline> {
        Converter::inlines(self, nodes)
    }
}

fn node_range(node: &Node) -> std::ops::Range<usize> {
    node.position()
        .map_or(0..0, |position| position.start.offset..position.end.offset)
}

/// The alert a quote's blocks make (GitHub's: the first line of its first
/// paragraph is `[!NOTE]`, ...), and that paragraph without it (`None`
/// when nothing else was in it).
fn alert(children: &[Node], source: &Source, quote: u32) -> Option<(Alert, Option<Node>)> {
    let Some(Node::Paragraph(paragraph)) = children.first() else {
        return None;
    };
    let Some(Node::Text(text)) = paragraph.children.first() else {
        return None;
    };
    let rest = text.value.strip_prefix("[!")?;
    let end = rest.find(']')?;
    let alert = match rest[..end].to_ascii_uppercase().as_str() {
        "NOTE" => Alert::Note,
        "TIP" => Alert::Tip,
        "IMPORTANT" => Alert::Important,
        "WARNING" => Alert::Warning,
        "CAUTION" => Alert::Caution,
        _ => return None,
    };
    let rest = rest[end + 1..].trim_start_matches([' ', '\t']);
    let mut first = paragraph.clone();
    if rest.is_empty() {
        // The marker's line ends with the text node: the paragraph ends,
        // or a hard break follows.
        match paragraph.children.get(1) {
            None => {
                first.children.remove(0);
            }
            Some(Node::Break(_)) => {
                first.children.drain(..2);
            }
            Some(_) => return None,
        }
    } else {
        let rest = rest.strip_prefix('\n')?;
        if let Some(Node::Text(text)) = first.children.first_mut() {
            text.value = rest.to_owned();
            // The alert marker was removed lexically. Advance the cloned
            // leaf's position past its line and its continuation prefix too.
            if let Some(position) = text.position.as_mut() {
                let raw = &source[position.start.offset..position.end.offset];
                let newline = raw.find('\n')? + 1;
                let prefix = source::continuation_length(&raw[newline..], quote);
                position.start.offset += newline + prefix;
                position.start.line += 1;
                position.start.column = prefix + 1;
            }
        }
    }
    let first = (!first.children.is_empty()).then_some(Node::Paragraph(first));
    Some((alert, first))
}

/// The name of the element `html` opens and does not close (`<details>`,
/// `<b class="x">`), but not of void elements.
fn unclosed_element(html: &str) -> Option<&str> {
    let inner = html.trim_start().strip_prefix('<')?;
    let len = inner
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-')
        .count();
    if len == 0 || !inner.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let name = &inner[..len];
    const VOID: &[&str] = &[
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
        "track", "wbr",
    ];
    if VOID.iter().any(|v| v.eq_ignore_ascii_case(name)) {
        return None;
    }
    let tag_end = inner.find('>')?;
    if inner[..tag_end].ends_with('/') {
        return None;
    }
    let closing = format!("</{}", name.to_ascii_lowercase());
    (!inner.to_ascii_lowercase().contains(&closing)).then_some(name)
}

/// Whether `html` is the closing tag of `name` (`</details>`).
fn is_closing_tag(html: &str, name: &str) -> bool {
    html.trim()
        .strip_prefix("</")
        .and_then(|rest| rest.strip_suffix('>'))
        .is_some_and(|rest| rest.trim().eq_ignore_ascii_case(name))
}

/// The sibling that closes the element `nodes[open]` opens.
fn matching_close(nodes: &[Node], open: usize, name: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, node) in nodes.iter().enumerate().skip(open + 1) {
        let Node::Html(html) = node else { continue };
        if unclosed_element(&html.value).is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            depth += 1;
        } else if is_closing_tag(&html.value, name) {
            if depth == 0 {
                return Some(i);
            }
            depth -= 1;
        }
    }
    None
}

/// Text `text` as written, its line breaks kept.
fn literal_lines(text: &str) -> Vec<Inline> {
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push(Inline::Break);
        }
        push_text(&mut out, line);
    }
    out
}

/// Whether content shows nothing.
fn is_blank(content: &[Inline]) -> bool {
    content
        .iter()
        .all(|i| matches!(i, Inline::Text { text } if text.trim().is_empty()))
}

fn push_text(out: &mut Vec<Inline>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text { text: last }) = out.last_mut() {
        last.push_str(text);
    } else {
        out.push(Inline::text(text));
    }
}

fn push(out: &mut Vec<Inline>, inline: Inline) {
    match inline {
        Inline::Text { text } => push_text(out, &text),
        other => out.push(other),
    }
}

fn extend(out: &mut Vec<Inline>, inlines: Vec<Inline>) {
    for inline in inlines {
        push(out, inline);
    }
}

/// The text of `blocks` ([`Block::plain_text`]), blank lines between.
fn blocks_text(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (i, block) in blocks.iter().enumerate() {
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(&block.plain_text());
    }
    out
}

fn inlines_text(content: &[Inline]) -> String {
    let mut out = String::new();
    inline_text(content, &mut out);
    out
}
