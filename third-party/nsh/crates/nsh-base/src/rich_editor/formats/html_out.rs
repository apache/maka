//! Documents into HTML: a port of `prosemirror-model`'s `DOMSerializer`
//! (`to_dom.ts`) writing an HTML string, with Tiptap's rendering of
//! attributes (`getRenderedAttributes`, `mergeAttributes`) and
//! `getHTMLFromFragment`.
//!
//! Each node and mark renders by its spec's `to_dom`
//! ([`DomOutputSpec`]); a type without one renders as a `<div
//! data-type="name">` (a `<span>` when inline), a mark as a `<span
//! data-mark="name">`, so every document can be written. Attributes with a
//! `render_html` are merged into the outer element (`class` and `style`
//! added to, others set). Marks open and close as ProseMirror's do: a
//! node's marks that match the open ones keep them open, the rest close
//! and reopen, so adjacent texts share their common marks.

use super::{DocFormat, DomParser, FormatError, ParseOptions};
use crate::rich_editor::model::{
    AttrRender, AttrSpec, Attrs, DomAttrValue, DomOutputSpec, DomSource, Fragment, Mark, Node,
    Schema, attr_value_text,
};

/// Elements written without content or an end tag.
const VOID_TAGS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// How deep callbacks may return further callbacks.
const MAX_RENDER_DEPTH: usize = 8;

/// Writes documents and fragments of a schema as HTML (ProseMirror's
/// `DOMSerializer`). Cheap to clone.
#[derive(Clone, Debug)]
pub struct DomSerializer {
    schema: Schema,
}

#[derive(Debug)]
enum Out {
    El(OutEl),
    Text(String),
}

#[derive(Debug, Default)]
struct OutEl {
    tag: String,
    attrs: Vec<(String, String)>,
    children: Vec<Out>,
}

impl OutEl {
    /// The element at `path` (child indices) below this one.
    fn at_mut(&mut self, path: &[usize]) -> &mut OutEl {
        match path.split_first() {
            None => self,
            Some((&i, rest)) => match &mut self.children[i] {
                Out::El(el) => el.at_mut(rest),
                Out::Text(_) => unreachable!("hole paths only name elements"),
            },
        }
    }

    fn set_attr(&mut self, name: &str, value: String) {
        match name {
            "class" => {
                let mut classes: Vec<String> = self
                    .attr("class")
                    .unwrap_or("")
                    .split_ascii_whitespace()
                    .map(str::to_owned)
                    .collect();
                for class in value.split_ascii_whitespace() {
                    if !classes.iter().any(|c| c == class) {
                        classes.push(class.to_owned());
                    }
                }
                self.put("class", classes.join(" "));
            }
            "style" => {
                for decl in value.split(';') {
                    if let Some((prop, v)) = decl.split_once(':') {
                        self.add_style(prop.trim(), v.trim());
                    }
                }
            }
            _ => self.put(name, value),
        }
    }

    /// Sets style property `prop`, replacing an earlier declaration of it
    /// (Tiptap's `mergeAttributes`).
    fn add_style(&mut self, prop: &str, value: &str) {
        if prop.is_empty() || value.is_empty() {
            return;
        }
        let mut decls: Vec<(String, String)> = self
            .attr("style")
            .unwrap_or("")
            .split(';')
            .filter_map(|d| d.split_once(':'))
            .map(|(p, v)| (p.trim().to_owned(), v.trim().to_owned()))
            .filter(|(p, _)| !p.is_empty())
            .collect();
        match decls.iter_mut().find(|(p, _)| p.eq_ignore_ascii_case(prop)) {
            Some(d) => d.1 = value.to_owned(),
            None => decls.push((prop.to_owned(), value.to_owned())),
        }
        let style = decls
            .iter()
            .map(|(p, v)| format!("{p}: {v}"))
            .collect::<Vec<_>>()
            .join("; ");
        self.put("style", style);
    }

    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn put(&mut self, name: &str, value: String) {
        match self.attrs.iter_mut().find(|(k, _)| k == name) {
            Some(a) => a.1 = value,
            None => self.attrs.push((name.to_owned(), value)),
        }
    }
}

/// An open mark: its element and the path of the element holding its
/// content.
struct Active {
    mark: Mark,
    el: OutEl,
    hole: Vec<usize>,
}

impl DomSerializer {
    /// A serializer of `schema`'s types, by their specs' `to_dom`.
    pub fn from_schema(schema: &Schema) -> DomSerializer {
        DomSerializer {
            schema: schema.clone(),
        }
    }

    /// The schema it writes.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// The HTML of `fragment`'s nodes, with their marks
    /// (`serializeFragment`).
    pub fn serialize_fragment(&self, fragment: &Fragment) -> String {
        let mut out = Vec::new();
        self.fragment_into(fragment, &mut out);
        write_all(&out)
    }

    /// The HTML of `node` wrapped in its marks (`serializeNode`).
    pub fn serialize_node(&self, node: &Node) -> String {
        let mut item = self.node_inner(node);
        for mark in node.marks().iter().rev() {
            let (mut el, hole) = self.render_mark(mark, node.is_inline());
            el.at_mut(&hole).children.push(item);
            item = Out::El(el);
        }
        write_all(&[item])
    }

    fn fragment_into(&self, fragment: &Fragment, out: &mut Vec<Out>) {
        let mut active: Vec<Active> = Vec::new();
        for node in fragment.iter() {
            let marks = node.marks();
            if !active.is_empty() || !marks.is_empty() {
                let mut keep = 0;
                let mut rendered = 0;
                while keep < active.len() && rendered < marks.len() {
                    let next = &marks[rendered];
                    if next != &active[keep].mark || !next.ty().spec().spanning {
                        break;
                    }
                    keep += 1;
                    rendered += 1;
                }
                while keep < active.len() {
                    close(&mut active, out);
                }
                for mark in &marks[rendered..] {
                    let (el, hole) = self.render_mark(mark, node.is_inline());
                    active.push(Active {
                        mark: mark.clone(),
                        el,
                        hole,
                    });
                }
            }
            let item = self.node_inner(node);
            push(&mut active, out, item);
        }
        while !active.is_empty() {
            close(&mut active, out);
        }
    }

    /// A node without its marks (`serializeNodeInner`).
    fn node_inner(&self, node: &Node) -> Out {
        if let Some(text) = node.text() {
            return Out::Text(text.to_owned());
        }
        let ty = node.ty();
        let rendered = ty
            .spec()
            .to_dom
            .as_ref()
            .and_then(|spec| render(spec, DomSource::Node(node), 0));
        let (mut out, hole) = rendered.unwrap_or_else(|| {
            let tag = if node.is_inline() { "span" } else { "div" };
            let el = OutEl {
                tag: tag.into(),
                attrs: vec![("data-type".into(), ty.name().into())],
                children: Vec::new(),
            };
            (Out::El(el), (!node.is_leaf()).then(Vec::new))
        });
        if let Out::El(el) = &mut out {
            render_attrs(el, &ty.spec().attrs, node.attrs());
            if let Some(hole) = hole
                && !node.is_leaf()
            {
                self.fragment_into(node.content(), &mut el.at_mut(&hole).children);
            }
        }
        out
    }

    /// A mark's element and the path of the element its content goes in.
    fn render_mark(&self, mark: &Mark, inline: bool) -> (OutEl, Vec<usize>) {
        let ty = mark.ty();
        let rendered = ty
            .spec()
            .to_dom
            .as_ref()
            .and_then(|spec| render(spec, DomSource::Mark { mark, inline }, 0));
        let (mut el, hole) = match rendered {
            Some((Out::El(el), hole)) => (el, hole.unwrap_or_default()),
            _ => (
                OutEl {
                    tag: "span".into(),
                    attrs: vec![("data-mark".into(), ty.name().into())],
                    children: Vec::new(),
                },
                Vec::new(),
            ),
        };
        render_attrs(&mut el, &ty.spec().attrs, mark.attrs());
        (el, hole)
    }
}

/// Appends `item` where content goes now: the innermost open mark, else
/// `out`.
fn push(active: &mut [Active], out: &mut Vec<Out>, item: Out) {
    match active.last_mut() {
        Some(a) => a.el.at_mut(&a.hole).children.push(item),
        None => out.push(item),
    }
}

fn close(active: &mut Vec<Active>, out: &mut Vec<Out>) {
    if let Some(a) = active.pop() {
        push(active, out, Out::El(a.el));
    }
}

/// Merges the rendered attributes into `el` (Tiptap's
/// `getRenderedAttributes` + `mergeAttributes`): each attribute at its
/// `render_html` place, by default the DOM attribute of its own name,
/// none when `rendered` is off, the place [`AttrRender::Skip`] or the
/// value null.
fn render_attrs(el: &mut OutEl, specs: &[(String, AttrSpec)], attrs: &Attrs) {
    for (name, spec) in specs {
        if !spec.rendered {
            continue;
        }
        let Some(value) = attrs.get(name).and_then(attr_value_text) else {
            continue;
        };
        match &spec.render_html {
            None if valid_name(name) => el.set_attr(name, value),
            Some(AttrRender::Attribute(dom)) if valid_name(dom) => el.set_attr(dom, value),
            Some(AttrRender::Style(prop)) => el.add_style(prop, &value),
            _ => {}
        }
    }
}

/// Renders `spec` for `src`: the tree and the path of the element holding
/// the hole, if any. A spec that renders nothing (a bare hole, a callback
/// loop) gives none.
fn render(
    spec: &DomOutputSpec,
    src: DomSource<'_>,
    depth: usize,
) -> Option<(Out, Option<Vec<usize>>)> {
    match spec {
        DomOutputSpec::Text(t) => Some((Out::Text(t.clone()), None)),
        DomOutputSpec::AttrText(name) => Some((
            Out::Text(
                src.attrs()
                    .get(name)
                    .and_then(attr_value_text)
                    .unwrap_or_default(),
            ),
            None,
        )),
        DomOutputSpec::Hole => None,
        DomOutputSpec::Render(f) => {
            if depth >= MAX_RENDER_DEPTH {
                log::warn!("toDOM callbacks nest too deep");
                return None;
            }
            render(&(f.0)(src), src, depth + 1)
        }
        DomOutputSpec::Element {
            tag,
            attrs,
            children,
        } => {
            let tag = if valid_name(tag) {
                tag.to_ascii_lowercase()
            } else {
                "span".into()
            };
            let mut el = OutEl {
                tag,
                ..Default::default()
            };
            for (name, value) in attrs {
                if !valid_name(name) {
                    continue;
                }
                let value = match value {
                    DomAttrValue::Value(v) => attr_value_text(v),
                    DomAttrValue::Attr(from) => src.attrs().get(from).and_then(attr_value_text),
                };
                if let Some(value) = value {
                    el.put(name, value);
                }
            }
            let mut hole = None;
            for child in children {
                if matches!(child, DomOutputSpec::Hole) {
                    hole = Some(Vec::new());
                    continue;
                }
                if let Some((out, child_hole)) = render(child, src, depth) {
                    if let Some(mut path) = child_hole {
                        path.insert(0, el.children.len());
                        hole = Some(path);
                    }
                    el.children.push(out);
                }
            }
            if VOID_TAGS.contains(&el.tag.as_str()) && (hole.is_some() || !el.children.is_empty()) {
                log::warn!(
                    "toDOM: <{}> is a void element; its content is dropped",
                    el.tag
                );
            }
            Some((Out::El(el), hole))
        }
    }
}

/// Whether `name` is safe as a tag or attribute name.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

fn write_all(items: &[Out]) -> String {
    let mut s = String::new();
    for item in items {
        write(item, &mut s);
    }
    s
}

fn write(item: &Out, s: &mut String) {
    match item {
        Out::Text(t) => escape(t, false, s),
        Out::El(el) => {
            s.push('<');
            s.push_str(&el.tag);
            for (name, value) in &el.attrs {
                s.push(' ');
                s.push_str(name);
                s.push_str("=\"");
                escape(value, true, s);
                s.push('"');
            }
            s.push('>');
            if VOID_TAGS.contains(&el.tag.as_str()) {
                return;
            }
            for child in &el.children {
                write(child, s);
            }
            s.push_str("</");
            s.push_str(&el.tag);
            s.push('>');
        }
    }
}

/// Escapes as browsers' HTML serialization does (`innerHTML`; `<` and
/// `>` in attributes too, as current browsers do).
fn escape(text: &str, attr: bool, s: &mut String) {
    for c in text.chars() {
        match c {
            '&' => s.push_str("&amp;"),
            '\u{a0}' => s.push_str("&nbsp;"),
            '"' if attr => s.push_str("&quot;"),
            '<' => s.push_str("&lt;"),
            '>' => s.push_str("&gt;"),
            c => s.push(c),
        }
    }
}

/// The HTML of `fragment`'s nodes in `schema` (Tiptap's
/// `getHTMLFromFragment`).
pub fn fragment_to_html(fragment: &Fragment, schema: &Schema) -> String {
    DomSerializer::from_schema(schema).serialize_fragment(fragment)
}

/// The HTML of a document's content (Tiptap's `getHTML`): its blocks,
/// without an element for the document itself.
pub fn doc_to_html(doc: &Node) -> String {
    fragment_to_html(doc.content(), doc.ty().schema())
}

/// Documents as HTML: read with the schema's parse rules ([`DomParser`]),
/// written with its `to_dom` specs ([`DomSerializer`]), as Tiptap's
/// `setContent(html)` / `getHTML()`. Reading never fails: what no rule
/// matches is dropped or read as text.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct HtmlFormat {}

impl DocFormat for HtmlFormat {
    type Error = FormatError;

    fn parse(&self, schema: &Schema, input: &str) -> Result<Node, FormatError> {
        let doc = DomParser::from_schema(schema).parse(input, &ParseOptions::default());
        doc.check()
            .map_err(|e| FormatError::Schema(e.to_string()))?;
        Ok(doc)
    }

    fn serialize(&self, doc: &Node) -> Result<String, FormatError> {
        Ok(doc_to_html(doc))
    }

    fn is_lossless_for(&self, _schema: &Schema) -> bool {
        // Parse rules and `to_dom` specs are free to disagree (callbacks
        // cannot be compared), so no schema is known to round-trip.
        false
    }
}

#[cfg(test)]
mod tests;
