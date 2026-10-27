//! Markdown (CommonMark with GFM's strikethrough), read with the
//! `markdown` crate's syntax tree and written as prosemirror-markdown
//! writes: escaped text, marks opened and closed around runs, whitespace
//! moved outside delimiters, fences longer than the code's backtick runs.

use std::collections::BTreeSet;

use markdown::mdast;
use serde_json::Value;

use super::{DocFormat, FormatError};
use crate::rich_editor::model::{Attrs, Fragment, Mark, Node, Schema};

/// The schema's names for what Markdown expresses. The defaults are the
/// starter schema's (`extensions::starter`); an app with other names maps
/// them here. A construct whose type the schema lacks reads as its text.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MarkdownNames {
    /// Paragraphs (`paragraph`).
    pub paragraph: String,
    /// Headings (`heading`), their level in [`Self::heading_level`].
    pub heading: String,
    /// The heading level attribute (`level`).
    pub heading_level: String,
    /// Block quotes (`blockquote`).
    pub blockquote: String,
    /// Fenced and indented code (`codeBlock`).
    pub code_block: String,
    /// The code block's language attribute (`language`).
    pub code_language: String,
    /// Thematic breaks (`horizontalRule`).
    pub horizontal_rule: String,
    /// Hard line breaks (`hardBreak`).
    pub hard_break: String,
    /// Images (`image`, attributes `src`, `alt`, `title`).
    pub image: String,
    /// Bullet lists (`bulletList`).
    pub bullet_list: String,
    /// Ordered lists (`orderedList`).
    pub ordered_list: String,
    /// The ordered list's first number attribute (`start`).
    pub list_start: String,
    /// List items (`listItem`).
    pub list_item: String,
    /// Strong emphasis (`bold`).
    pub strong: String,
    /// Emphasis (`italic`).
    pub emphasis: String,
    /// Code spans (`code`).
    pub code: String,
    /// Links (`link`, attributes `href`, `title`).
    pub link: String,
    /// Strikethrough (`strike`).
    pub strike: String,
}

impl Default for MarkdownNames {
    fn default() -> Self {
        Self {
            paragraph: "paragraph".into(),
            heading: "heading".into(),
            heading_level: "level".into(),
            blockquote: "blockquote".into(),
            code_block: "codeBlock".into(),
            code_language: "language".into(),
            horizontal_rule: "horizontalRule".into(),
            hard_break: "hardBreak".into(),
            image: "image".into(),
            bullet_list: "bulletList".into(),
            ordered_list: "orderedList".into(),
            list_start: "start".into(),
            list_item: "listItem".into(),
            strong: "bold".into(),
            emphasis: "italic".into(),
            code: "code".into(),
            link: "link".into(),
            strike: "strike".into(),
        }
    }
}

impl MarkdownNames {
    fn node_names(&self) -> [&str; 10] {
        [
            &self.paragraph,
            &self.heading,
            &self.blockquote,
            &self.code_block,
            &self.horizontal_rule,
            &self.hard_break,
            &self.image,
            &self.bullet_list,
            &self.ordered_list,
            &self.list_item,
        ]
    }

    fn mark_names(&self) -> [&str; 4] {
        [&self.strong, &self.emphasis, &self.code, &self.link]
    }
}

/// Documents as Markdown, mapped to the schema by [`MarkdownNames`].
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MarkdownFormat {
    /// The schema's names for Markdown's constructs.
    pub names: MarkdownNames,
}

impl MarkdownFormat {
    /// A format with the schema's own names.
    pub fn new(names: MarkdownNames) -> Self {
        Self { names }
    }

    /// The node and mark types in `doc` that Markdown cannot express, by
    /// name, sorted: what writing `doc` loses besides attributes Markdown
    /// has no syntax for and whitespace it collapses.
    pub fn losses(&self, doc: &Node) -> Vec<String> {
        let mut lost = BTreeSet::new();
        self.collect_losses(doc, &mut lost);
        lost.into_iter().collect()
    }

    fn collect_losses(&self, node: &Node, lost: &mut BTreeSet<String>) {
        for i in 0..node.child_count() {
            let child = node.child(i);
            let name = child.ty().name();
            if !child.is_text() && !self.names.node_names().contains(&name) {
                lost.insert(name.to_string());
            }
            for mark in child.marks() {
                let m = mark.ty.name();
                if !self.names.mark_names().contains(&m) && m != self.names.strike {
                    lost.insert(m.to_string());
                }
            }
            self.collect_losses(child, lost);
        }
    }
}

impl MarkdownFormat {
    /// Writes blocks (or inline content, as one paragraph) as Markdown,
    /// without a trailing newline: what a copied slice puts on the
    /// clipboard.
    pub fn serialize_fragment(&self, fragment: &Fragment) -> String {
        Writer { names: &self.names }.fragment(fragment)
    }

    /// Reads Markdown into the blocks of a document of `schema`.
    pub fn parse_fragment(&self, schema: &Schema, input: &str) -> Result<Fragment, FormatError> {
        Ok(self.parse(schema, input)?.content().clone())
    }
}

impl DocFormat for MarkdownFormat {
    type Error = FormatError;

    fn parse(&self, schema: &Schema, input: &str) -> Result<Node, FormatError> {
        let root = markdown::to_mdast(input, &markdown::ParseOptions::gfm())
            .map_err(|e| FormatError::Markdown(e.to_string()))?;
        let reader = Reader {
            schema,
            names: &self.names,
        };
        let mut blocks = reader.blocks(root.children().map(Vec::as_slice).unwrap_or(&[]))?;
        if blocks.is_empty() {
            blocks.push(reader.node(&self.names.paragraph, Attrs::new(), Vec::new())?);
        }
        let top = schema.top_node_type();
        let doc = reader.node(top.name(), Attrs::new(), blocks)?;
        doc.check()
            .map_err(|e| FormatError::Schema(e.to_string()))?;
        Ok(doc)
    }

    fn serialize(&self, doc: &Node) -> Result<String, FormatError> {
        let writer = Writer { names: &self.names };
        let mut out = writer.blocks(doc);
        if !out.is_empty() {
            out.push('\n');
        }
        Ok(out)
    }

    fn is_lossless_for(&self, schema: &Schema) -> bool {
        // Underlines, custom nodes and attributes beyond those mapped have
        // no Markdown syntax; a schema without any of them still loses
        // empty paragraphs and leading whitespace, which Markdown
        // collapses, so no schema is lossless.
        let _ = schema;
        false
    }
}

/// Reads mdast into the schema's nodes.
struct Reader<'a> {
    schema: &'a Schema,
    names: &'a MarkdownNames,
}

impl Reader<'_> {
    fn has_node(&self, name: &str) -> bool {
        self.schema.node_type(name).is_some()
    }

    fn node(&self, name: &str, attrs: Attrs, content: Vec<Node>) -> Result<Node, FormatError> {
        self.schema
            .node(name, Some(attrs), Fragment::from(content), Vec::new())
            .map_err(|e| FormatError::Schema(e.to_string()))
    }

    fn mark(&self, name: &str, attrs: Attrs) -> Option<Mark> {
        self.schema.mark_type(name)?;
        self.schema.mark(name, Some(attrs)).ok()
    }

    fn paragraph(&self, inline: Vec<Node>) -> Result<Node, FormatError> {
        self.node(&self.names.paragraph, Attrs::new(), inline)
    }

    fn blocks(&self, nodes: &[mdast::Node]) -> Result<Vec<Node>, FormatError> {
        let mut out = Vec::new();
        for node in nodes {
            self.block(node, &mut out)?;
        }
        Ok(out)
    }

    fn block(&self, node: &mdast::Node, out: &mut Vec<Node>) -> Result<(), FormatError> {
        let n = self.names;
        match node {
            mdast::Node::Paragraph(p) => {
                let inline = self.inlines(&p.children, &[]);
                out.push(self.paragraph(inline)?);
            }
            mdast::Node::Heading(h) => {
                let inline = self.inlines(&h.children, &[]);
                if self.has_node(&n.heading) {
                    let mut attrs = Attrs::new();
                    attrs.insert(n.heading_level.clone(), Value::from(h.depth));
                    out.push(self.node(&n.heading, attrs, inline)?);
                } else {
                    out.push(self.paragraph(inline)?);
                }
            }
            mdast::Node::Blockquote(q) => {
                let inner = self.blocks(&q.children)?;
                if self.has_node(&n.blockquote) {
                    out.push(self.node(&n.blockquote, Attrs::new(), inner)?);
                } else {
                    out.extend(inner);
                }
            }
            mdast::Node::Code(c) => {
                let text = self.text(&c.value, Vec::new());
                if self.has_node(&n.code_block) {
                    let mut attrs = Attrs::new();
                    if let Some(lang) = &c.lang {
                        attrs.insert(n.code_language.clone(), Value::from(lang.as_str()));
                    }
                    out.push(self.node(&n.code_block, attrs, text)?);
                } else {
                    out.push(self.paragraph(text)?);
                }
            }
            mdast::Node::ThematicBreak(_) => {
                if self.has_node(&n.horizontal_rule) {
                    out.push(self.node(&n.horizontal_rule, Attrs::new(), Vec::new())?);
                }
            }
            mdast::Node::List(l) => {
                let (name, attrs) = if l.ordered {
                    let mut attrs = Attrs::new();
                    attrs.insert(n.list_start.clone(), Value::from(l.start.unwrap_or(1)));
                    (&n.ordered_list, attrs)
                } else {
                    (&n.bullet_list, Attrs::new())
                };
                if self.has_node(name) && self.has_node(&n.list_item) {
                    let mut items = Vec::new();
                    for item in &l.children {
                        let children = item.children().map(Vec::as_slice).unwrap_or(&[]);
                        let mut inner = self.blocks(children)?;
                        if inner.is_empty() {
                            inner.push(self.paragraph(Vec::new())?);
                        }
                        items.push(self.node(&n.list_item, Attrs::new(), inner)?);
                    }
                    out.push(self.node(name, attrs, items)?);
                } else {
                    for item in &l.children {
                        out.extend(self.blocks(item.children().map(Vec::as_slice).unwrap_or(&[]))?);
                    }
                }
            }
            mdast::Node::Html(h) => {
                let text = self.text(&h.value, Vec::new());
                out.push(self.paragraph(text)?);
            }
            other => match other.children() {
                // Containers the schema does not know (tables, footnotes)
                // keep their blocks; what has no children keeps its text.
                Some(children) if children.iter().any(is_block) => {
                    out.extend(self.blocks(children)?);
                }
                _ => {
                    let inline = self.inlines(std::slice::from_ref(other), &[]);
                    if !inline.is_empty() {
                        out.push(self.paragraph(inline)?);
                    }
                }
            },
        }
        Ok(())
    }

    fn text(&self, text: &str, marks: Vec<Mark>) -> Vec<Node> {
        if text.is_empty() {
            Vec::new()
        } else {
            vec![self.schema.text(text, marks)]
        }
    }

    fn inlines(&self, nodes: &[mdast::Node], marks: &[Mark]) -> Vec<Node> {
        let mut out = Vec::new();
        for node in nodes {
            self.inline(node, marks, &mut out);
        }
        out
    }

    fn with_mark(&self, marks: &[Mark], name: &str, attrs: Attrs) -> Vec<Mark> {
        match self.mark(name, attrs) {
            Some(mark) => mark.add_to_set(marks),
            None => marks.to_vec(),
        }
    }

    fn inline(&self, node: &mdast::Node, marks: &[Mark], out: &mut Vec<Node>) {
        let n = self.names;
        match node {
            mdast::Node::Text(t) => out.extend(self.text(&t.value, marks.to_vec())),
            mdast::Node::Html(h) => out.extend(self.text(&h.value, marks.to_vec())),
            mdast::Node::InlineCode(c) => {
                let marks = self.with_mark(marks, &n.code, Attrs::new());
                out.extend(self.text(&c.value, marks));
            }
            mdast::Node::Strong(s) => {
                let marks = self.with_mark(marks, &n.strong, Attrs::new());
                out.extend(self.inlines(&s.children, &marks));
            }
            mdast::Node::Emphasis(e) => {
                let marks = self.with_mark(marks, &n.emphasis, Attrs::new());
                out.extend(self.inlines(&e.children, &marks));
            }
            mdast::Node::Delete(d) => {
                let marks = self.with_mark(marks, &n.strike, Attrs::new());
                out.extend(self.inlines(&d.children, &marks));
            }
            mdast::Node::Link(l) => {
                let mut attrs = Attrs::new();
                attrs.insert("href".into(), Value::from(l.url.as_str()));
                attrs.insert(
                    "title".into(),
                    l.title.as_deref().map_or(Value::Null, Value::from),
                );
                let marks = self.with_mark(marks, &n.link, attrs);
                out.extend(self.inlines(&l.children, &marks));
            }
            mdast::Node::Break(_) => {
                match self
                    .schema
                    .node(&n.hard_break, None, Fragment::empty(), marks.to_vec())
                {
                    Ok(node) if self.has_node(&n.hard_break) => out.push(node),
                    _ => out.extend(self.text("\n", marks.to_vec())),
                }
            }
            mdast::Node::Image(i) => {
                let mut attrs = Attrs::new();
                attrs.insert("src".into(), Value::from(i.url.as_str()));
                attrs.insert("alt".into(), Value::from(i.alt.as_str()));
                attrs.insert(
                    "title".into(),
                    i.title.as_deref().map_or(Value::Null, Value::from),
                );
                match self
                    .schema
                    .node(&n.image, Some(attrs), Fragment::empty(), marks.to_vec())
                {
                    Ok(node) if self.has_node(&n.image) => out.push(node),
                    _ => out.extend(self.text(&i.alt, marks.to_vec())),
                }
            }
            other => match other.children() {
                Some(children) => out.extend(self.inlines(children, marks)),
                None => out.extend(self.text(&other.to_string(), marks.to_vec())),
            },
        }
    }
}

fn is_block(node: &mdast::Node) -> bool {
    matches!(
        node,
        mdast::Node::Paragraph(_)
            | mdast::Node::Heading(_)
            | mdast::Node::Blockquote(_)
            | mdast::Node::Code(_)
            | mdast::Node::List(_)
            | mdast::Node::ThematicBreak(_)
            | mdast::Node::Table(_)
            | mdast::Node::TableRow(_)
            | mdast::Node::TableCell(_)
    )
}

/// Writes documents as Markdown.
struct Writer<'a> {
    names: &'a MarkdownNames,
}

impl Writer<'_> {
    /// A container's blocks, separated by blank lines.
    fn blocks(&self, node: &Node) -> String {
        self.fragment(node.content())
    }

    /// Blocks separated by blank lines, or inline content as one line.
    fn fragment(&self, fragment: &Fragment) -> String {
        if fragment.child_count() > 0 && fragment.child(0).is_inline() {
            return self.inline(fragment);
        }
        let mut parts = Vec::new();
        for i in 0..fragment.child_count() {
            parts.push(self.block(fragment.child(i)));
        }
        parts.join("\n\n")
    }

    fn block(&self, node: &Node) -> String {
        let n = self.names;
        let name = node.ty().name();
        if name == n.heading {
            let level = node
                .attrs()
                .get(&n.heading_level)
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6);
            format!(
                "{} {}",
                "#".repeat(level as usize),
                self.inline(node.content())
            )
        } else if name == n.blockquote {
            prefix_lines(&self.blocks(node), "> ", ">")
        } else if name == n.code_block {
            let text = node.text_content();
            let fence = "`".repeat(longest_run(&text, '`').max(2) + 1);
            let lang = node
                .attrs()
                .get(&n.code_language)
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("{fence}{lang}\n{text}\n{fence}")
        } else if name == n.horizontal_rule {
            "---".into()
        } else if name == n.bullet_list || name == n.ordered_list {
            self.list(node, name == n.ordered_list)
        } else if node.is_textblock() {
            self.inline(node.content())
        } else if node.is_leaf() {
            String::new()
        } else {
            self.blocks(node)
        }
    }

    fn list(&self, node: &Node, ordered: bool) -> String {
        let start = node
            .attrs()
            .get(&self.names.list_start)
            .and_then(Value::as_u64)
            .unwrap_or(1);
        // A list whose items are one block each is tight; otherwise loose,
        // so items' paragraphs read back as such either way.
        let tight = (0..node.child_count()).all(|i| node.child(i).child_count() <= 1);
        let mut items = Vec::new();
        for i in 0..node.child_count() {
            let marker = if ordered {
                format!("{}. ", start + i as u64)
            } else {
                "- ".to_string()
            };
            let indent = " ".repeat(marker.len());
            let body = self.blocks(node.child(i));
            let mut item = String::new();
            for (j, line) in body.split('\n').enumerate() {
                if j == 0 {
                    item.push_str(&marker);
                } else {
                    item.push('\n');
                    if !line.is_empty() {
                        item.push_str(&indent);
                    }
                }
                item.push_str(line);
            }
            items.push(item);
        }
        items.join(if tight { "\n" } else { "\n\n" })
    }

    /// A textblock's inline content with its marks.
    fn inline(&self, block: &Fragment) -> String {
        let n = self.names;
        let mut out = String::new();
        let mut open: Vec<Mark> = Vec::new();
        let mut line_start = true;
        for i in 0..block.child_count() {
            let child = block.child(i);
            let mut marks: Vec<Mark> = child
                .marks()
                .iter()
                .filter(|m| {
                    let name = m.ty.name();
                    name != n.code && (n.mark_names().contains(&name) || name == n.strike)
                })
                .cloned()
                .collect();
            let code = child.marks().iter().any(|m| m.ty.name() == n.code);
            // Marks already open stay open: they go first, so `*a **b***`
            // does not close and reopen the emphasis around `b`.
            let keep = open
                .iter()
                .take_while(|m| marks.iter().any(|x| x.eq(m)))
                .count();
            marks.retain(|m| !open[..keep].iter().any(|o| o.eq(m)));
            marks.splice(0..0, open[..keep].iter().cloned());
            // Close the open marks this child does not continue, from the
            // innermost, with trailing whitespace moved after them.
            if keep < open.len() {
                let trimmed = out.trim_end_matches([' ', '\t']).len();
                let ws = out.split_off(trimmed);
                for mark in open.drain(keep..).rev() {
                    out.push_str(&self.close(&mark));
                }
                out.push_str(&ws);
            }
            let content = if let Some(text) = child.text() {
                if code {
                    code_span(text)
                } else {
                    escape(text, line_start)
                }
            } else if child.ty().name() == n.hard_break {
                "\\\n".to_string()
            } else if child.ty().name() == n.image {
                let attr = |k: &str| {
                    child
                        .attrs()
                        .get(k)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                format!(
                    "![{}]({})",
                    escape(&attr("alt"), false),
                    destination(&attr("src"), &attr("title"))
                )
            } else {
                String::new()
            };
            if keep < marks.len() {
                // Leading whitespace stays outside the delimiters, which
                // must touch the text to open.
                let trimmed = content.trim_start_matches([' ', '\t']);
                out.push_str(&content[..content.len() - trimmed.len()]);
                for mark in &marks[keep..] {
                    out.push_str(&self.open(mark));
                }
                open.extend_from_slice(&marks[keep..]);
                out.push_str(trimmed);
            } else {
                out.push_str(&content);
            }
            line_start = out.ends_with('\n');
        }
        let trimmed = out.trim_end_matches([' ', '\t']).len();
        let ws = out.split_off(trimmed);
        for mark in open.drain(..).rev() {
            out.push_str(&self.close(&mark));
        }
        out.push_str(&ws);
        out
    }

    fn open(&self, mark: &Mark) -> String {
        let n = self.names;
        let name = mark.ty.name();
        if name == n.strong {
            "**".into()
        } else if name == n.emphasis {
            "*".into()
        } else if name == n.strike {
            "~~".into()
        } else if name == n.link {
            "[".into()
        } else {
            String::new()
        }
    }

    fn close(&self, mark: &Mark) -> String {
        if mark.ty.name() == self.names.link {
            let attr = |k: &str| {
                mark.attrs
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            format!("]({})", destination(&attr("href"), &attr("title")))
        } else {
            self.open(mark)
        }
    }
}

fn prefix_lines(text: &str, prefix: &str, empty: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                empty.to_string()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn longest_run(text: &str, c: char) -> usize {
    let (mut best, mut run) = (0, 0);
    for ch in text.chars() {
        run = if ch == c { run + 1 } else { 0 };
        best = best.max(run);
    }
    best
}

/// A code span whose fence is longer than the backtick runs inside, padded
/// when the text starts or ends with a backtick.
fn code_span(text: &str) -> String {
    let fence = "`".repeat(longest_run(text, '`') + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{text}{pad}{fence}")
}

/// A link destination and title: angle brackets when the URL has spaces
/// or parentheses, the title quoted with its quotes escaped.
fn destination(url: &str, title: &str) -> String {
    let url = if url.contains([' ', '(', ')', '<', '>']) || url.is_empty() {
        format!("<{}>", url.replace('<', "\\<").replace('>', "\\>"))
    } else {
        url.to_string()
    };
    if title.is_empty() {
        url
    } else {
        format!(
            "{url} \"{}\"",
            title.replace('\\', "\\\\").replace('"', "\\\"")
        )
    }
}

/// Escapes text so it reads back as the same text: the characters that
/// open inline syntax everywhere, and what starts a block at a line's
/// start (`#`, `>`, list markers, setext underlines).
fn escape(text: &str, mut line_start: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if line_start {
            match c {
                '#' | '>' | '-' | '+' | '=' => out.push('\\'),
                d if d.is_ascii_digit() => {
                    let end = chars[i..]
                        .iter()
                        .position(|c| !c.is_ascii_digit())
                        .map_or(chars.len(), |p| i + p);
                    if matches!(chars.get(end), Some('.' | ')')) {
                        out.extend(&chars[i..end]);
                        out.push('\\');
                        out.push(chars[end]);
                        i = end + 1;
                        line_start = false;
                        continue;
                    }
                }
                _ => {}
            }
        }
        match c {
            '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '~' | '|' => out.push('\\'),
            '&' if chars
                .get(i + 1)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '#') =>
            {
                out.push('\\')
            }
            '!' if chars.get(i + 1) == Some(&'[') => out.push('\\'),
            _ => {}
        }
        out.push(c);
        line_start = c == '\n';
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::extensions::starter;

    fn round_trip(md: &str) -> (Node, String) {
        let schema = starter::schema();
        let f = MarkdownFormat::default();
        let doc = f.parse(&schema, md).unwrap();
        let out = f.serialize(&doc).unwrap();
        let again = f.parse(&schema, &out).unwrap();
        assert!(doc.eq(&again), "not stable: {md:?} -> {out:?}");
        (doc, out)
    }

    #[test]
    fn blocks_round_trip() {
        let md =
            "# One\n\n### Three\n\n> quote\n>\n> more\n\n```rust\nfn x() {}\n```\n\n---\n\nend\n";
        let (doc, out) = round_trip(md);
        assert_eq!(out, md);
        assert_eq!(doc.child(0).ty().name(), "heading");
        assert_eq!(doc.child(1).attrs().get("level"), Some(&Value::from(3)));
        assert_eq!(
            doc.child(3).attrs().get("language"),
            Some(&Value::from("rust"))
        );
        assert_eq!(doc.child(4).ty().name(), "horizontalRule");
    }

    #[test]
    fn lists_round_trip() {
        let (doc, out) = round_trip("- a\n- b\n  - nested\n\n3. three\n4. four\n");
        assert_eq!(out, "- a\n\n- b\n\n  - nested\n\n3. three\n4. four\n");
        assert_eq!(doc.child(0).ty().name(), "bulletList");
        assert_eq!(doc.child(1).attrs().get("start"), Some(&Value::from(3)));
    }

    #[test]
    fn marks_round_trip() {
        let md = "**bold** and *it **both*** ``co`de`` ~~gone~~ [link](https://x.y \"T\")\n";
        let (doc, out) = round_trip(md);
        assert_eq!(out, md);
        let para = doc.child(0);
        assert!(para.child(0).marks().iter().any(|m| m.ty.name() == "bold"));
    }

    #[test]
    fn hard_breaks_round_trip() {
        let (doc, out) = round_trip("one\\\ntwo\n");
        assert_eq!(out, "one\\\ntwo\n");
        assert_eq!(doc.child(0).child(1).ty().name(), "hardBreak");
    }

    #[test]
    fn whitespace_moves_outside_marks() {
        let schema = starter::schema();
        let bold = schema.mark("bold", None).unwrap();
        let para = schema
            .node(
                "paragraph",
                None,
                Fragment::from(vec![
                    schema.text("a", Vec::new()),
                    schema.text(" b ", vec![bold]),
                    schema.text("c", Vec::new()),
                ]),
                Vec::new(),
            )
            .unwrap();
        let doc = schema
            .node("doc", None, Fragment::from(vec![para]), Vec::new())
            .unwrap();
        assert_eq!(
            MarkdownFormat::default().serialize(&doc).unwrap(),
            "a **b** c\n"
        );
    }

    #[test]
    fn text_is_escaped() {
        let schema = starter::schema();
        let tricky = "# not *a* _heading_ [x](y) `z` <b> &amp; 1. \\ ~~s~~ ![i]";
        let para = schema
            .node(
                "paragraph",
                None,
                Fragment::from(vec![schema.text(tricky, Vec::new())]),
                Vec::new(),
            )
            .unwrap();
        let doc = schema
            .node("doc", None, Fragment::from(vec![para]), Vec::new())
            .unwrap();
        let f = MarkdownFormat::default();
        let out = f.serialize(&doc).unwrap();
        let again = f.parse(&schema, &out).unwrap();
        assert_eq!(again.text_content(), tricky, "{out}");
        for start in ["- item", "+ item", "> q", "12. x", "=", "3) y"] {
            let p = schema
                .node(
                    "paragraph",
                    None,
                    Fragment::from(vec![schema.text(start, Vec::new())]),
                    Vec::new(),
                )
                .unwrap();
            let doc = schema
                .node("doc", None, Fragment::from(vec![p]), Vec::new())
                .unwrap();
            let back = f.parse(&schema, &f.serialize(&doc).unwrap()).unwrap();
            assert!(doc.eq(&back), "{start:?}");
        }
    }

    #[test]
    fn losses_are_reported() {
        let schema = starter::schema();
        let f = MarkdownFormat::default();
        assert!(!f.is_lossless_for(&schema));
        let underline = schema.mark("underline", None).unwrap();
        let para = schema
            .node(
                "paragraph",
                None,
                Fragment::from(vec![schema.text("u", vec![underline])]),
                Vec::new(),
            )
            .unwrap();
        let doc = schema
            .node("doc", None, Fragment::from(vec![para]), Vec::new())
            .unwrap();
        assert_eq!(f.losses(&doc), vec!["underline".to_string()]);
        assert_eq!(f.serialize(&doc).unwrap(), "u\n");
        let plain = f.parse(&schema, "plain").unwrap();
        assert!(f.losses(&plain).is_empty());
    }

    #[test]
    fn empty_input_is_one_paragraph() {
        let schema = starter::schema();
        let doc = MarkdownFormat::default().parse(&schema, "").unwrap();
        assert_eq!(doc.child_count(), 1);
    }
}
