//! HTML into documents: a port of `prosemirror-model`'s `DOMParser`
//! (`from_dom.ts`) and of the fitting `prosemirror-view` gives pasted HTML
//! (`clipboard.ts`'s `parseFromClipboard`: `normalizeSiblings`,
//! `closeSlice`).
//!
//! The rules come from the schema's node and mark specs (`parse_dom`),
//! sorted by priority. HTML is parsed by html5ever as a browser parses it
//! into an owned [`DomElement`] tree, then walked by a `ParseContext` as
//! ProseMirror's: a stack of open nodes, content placed with
//! `findWrapping`, loose inline content wrapped in the default textblock,
//! whitespace collapsed unless preserved, marks from tag and style rules.

use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use html5ever::{ParseOpts, parse_document, tendril::TendrilSink};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use serde_json::Value;

use crate::rich_editor::model::{
    AttrParse, AttrType, Attrs, ContentMatch, DomElement, DomNode, Fragment, Mark, MarkType, Node,
    NodeType, ParseRule, ResolvedPos, RuleInput, Schema, Slice, Whitespace,
};

/// Elements that are blocks in HTML: content around them is not inline.
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "canvas",
    "dd",
    "div",
    "dl",
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
    "li",
    "noscript",
    "ol",
    "output",
    "p",
    "pre",
    "section",
    "table",
    "tfoot",
    "ul",
];

/// Elements whose content is dropped unless a rule says otherwise.
const IGNORE_TAGS: &[&str] = &["head", "noscript", "object", "script", "style", "title"];

const LIST_TAGS: &[&str] = &["ol", "ul"];

/// Inline elements a trailing `<br>` of pasted HTML is kept in.
const INLINE_PARENTS: &[&str] = &[
    "a", "abbr", "acronym", "b", "cite", "code", "del", "em", "i", "ins", "kbd", "label", "output",
    "q", "ruby", "s", "samp", "span", "strong", "sub", "sup", "time", "u", "tt", "var",
];

const OPT_PRESERVE_WS: u8 = 1;
const OPT_PRESERVE_WS_FULL: u8 = 2;
const OPT_OPEN_LEFT: u8 = 4;

/// Deeper elements are dropped: the walk is recursive.
const MAX_DEPTH: usize = 256;

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{c}')
}

fn has_non_ws(s: &str) -> bool {
    s.chars().any(|c| !is_ws(c))
}

fn ws_options_for(ty: Option<&NodeType>, preserve: Option<Whitespace>, base: u8) -> u8 {
    match preserve {
        Some(Whitespace::Collapse) => 0,
        Some(Whitespace::Preserve) => OPT_PRESERVE_WS,
        Some(Whitespace::Full) => OPT_PRESERVE_WS | OPT_PRESERVE_WS_FULL,
        None if ty.is_some_and(|t| t.whitespace() == "pre") => {
            OPT_PRESERVE_WS | OPT_PRESERVE_WS_FULL
        }
        None => base & !OPT_OPEN_LEFT,
    }
}

/// Options of [`DomParser::parse`] and [`DomParser::parse_slice`]
/// (ProseMirror's `ParseOptions`).
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ParseOptions {
    /// How whitespace is treated at the top level (collapsed by default).
    pub preserve_whitespace: Option<Whitespace>,
    /// The node to parse into, instead of an empty node of the schema's top
    /// type: its type and attributes are used, its content ignored.
    pub top_node: Option<Node>,
    /// The content match the top node's content starts at.
    pub top_match: Option<ContentMatch>,
    /// Whether the top node is left open: what its content requires at the
    /// end is not filled in.
    pub top_open: bool,
    /// Where the content will land: rules' `context` match against its
    /// ancestors, and loose inline content takes the textblock it allows.
    pub context: Option<ResolvedPos>,
}

#[derive(Clone)]
enum Target {
    Node(NodeType),
    Mark(MarkType),
    None,
}

#[derive(Clone)]
struct Rule {
    rule: ParseRule,
    target: Target,
}

/// Reads HTML into documents and slices of a schema with parse rules
/// (ProseMirror's `DOMParser`). Cheap to clone.
#[derive(Clone)]
pub struct DomParser {
    schema: Schema,
    tags: Arc<[Rule]>,
    styles: Arc<[Rule]>,
    matched_styles: Arc<[String]>,
    normalize_lists: bool,
}

impl fmt::Debug for DomParser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DomParser")
            .field("tags", &self.tags.len())
            .field("styles", &self.styles.len())
            .finish()
    }
}

impl DomParser {
    /// The parser of the rules in `schema`'s node and mark specs, made once
    /// per schema (ProseMirror's `DOMParser.fromSchema`).
    pub fn from_schema(schema: &Schema) -> DomParser {
        (*schema.cached("nsh.rich_editor.dom_parser", || {
            DomParser::new(schema, Self::schema_rules(schema))
        }))
        .clone()
    }

    /// The rules of `schema`'s specs, by descending priority (marks' first,
    /// then nodes', each in schema order), each naming the type it creates.
    pub fn schema_rules(schema: &Schema) -> Vec<ParseRule> {
        let mut result: Vec<ParseRule> = Vec::new();
        let mut insert = |rule: ParseRule| {
            let priority = rule.effective_priority();
            let at = result
                .iter()
                .position(|r| r.effective_priority() < priority)
                .unwrap_or(result.len());
            result.insert(at, rule);
        };
        for ty in schema.mark_types() {
            for rule in &ty.spec().parse_dom {
                let mut rule = rule.clone();
                if rule.mark.is_none()
                    && rule.node.is_none()
                    && !rule.ignore
                    && rule.clear_mark.is_none()
                {
                    rule.mark = Some(ty.name().to_owned());
                }
                insert(rule);
            }
        }
        for ty in schema.node_types() {
            for rule in &ty.spec().parse_dom {
                let mut rule = rule.clone();
                if rule.node.is_none() && rule.mark.is_none() && !rule.ignore {
                    rule.node = Some(ty.name().to_owned());
                }
                insert(rule);
            }
        }
        result
    }

    /// A parser of `rules` in their order, each naming the node or mark it
    /// creates (rules naming unknown types are dropped).
    pub fn new(schema: &Schema, rules: Vec<ParseRule>) -> DomParser {
        let mut tags = Vec::new();
        let mut styles = Vec::new();
        let mut matched_styles: Vec<String> = Vec::new();
        for rule in rules {
            let target = if let Some(name) = &rule.node {
                match schema.node_type(name) {
                    Some(ty) => Target::Node(ty),
                    None => {
                        log::warn!("parse rule names unknown node type {name}");
                        continue;
                    }
                }
            } else if let Some(name) = &rule.mark {
                match schema.mark_type(name) {
                    Some(ty) => Target::Mark(ty),
                    None => {
                        log::warn!("parse rule names unknown mark type {name}");
                        continue;
                    }
                }
            } else {
                Target::None
            };
            if rule.tag.is_some() {
                tags.push(Rule { rule, target });
            } else if let Some(style) = &rule.style {
                let prop = style.split('=').next().unwrap_or("").to_ascii_lowercase();
                if !matched_styles.contains(&prop) {
                    matched_styles.push(prop);
                }
                styles.push(Rule { rule, target });
            }
        }
        // Lists are normalized (sublists moved into the item before them)
        // unless a list rule's node may hold lists directly.
        let normalize_lists = !tags.iter().any(|r| {
            let Some(tag) = &r.rule.tag else { return false };
            let tag = tag.trim_start();
            let is_list = ["ul", "ol"].iter().any(|l| {
                tag.starts_with(l)
                    && !tag[l.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            });
            match (&r.target, is_list) {
                (Target::Node(ty), true) => ty.content_match().match_type(ty).is_some(),
                _ => false,
            }
        });
        DomParser {
            schema: schema.clone(),
            tags: tags.into(),
            styles: styles.into(),
            matched_styles: matched_styles.into(),
            normalize_lists,
        }
    }

    /// The schema it parses into.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// `html` as a whole document (ProseMirror's `parse`): what the top
    /// node requires is filled in.
    pub fn parse(&self, html: &str, options: &ParseOptions) -> Node {
        let body = self.read_html(html);
        let mut cx = ParseContext::new(self, options, false, false);
        cx.add_all(&body, Vec::new());
        match cx.finish() {
            Finished::Node(node) => node,
            Finished::Fragment(content) => self
                .schema
                .top_node_type()
                .create_and_fill(None, content, vec![])
                .unwrap_or_else(|| {
                    self.schema
                        .top_node_type()
                        .create_and_fill(None, Fragment::empty(), vec![])
                        .expect("the top node type can be created empty")
                }),
        }
    }

    /// `html` as an open slice (ProseMirror's `parseSlice`): its content is
    /// not wrapped in a top node, and opens as deep as it can.
    pub fn parse_slice(&self, html: &str, options: &ParseOptions) -> Slice {
        let body = self.read_html(html);
        let mut cx = ParseContext::new(self, options, true, false);
        cx.add_all(&body, Vec::new());
        Slice::max_open(cx.finish().into_fragment(), true)
    }

    /// Pasted `html` as the slice that fits at `context` (ProseMirror's
    /// `parseFromClipboard` for HTML): parsed in that context, sibling
    /// nodes wrapped so they fit where they land together, then opened as
    /// deep as non-isolating nodes allow. A trailing `<br>` of a block is
    /// dropped as browsers do.
    pub fn parse_with_context(&self, html: &str, context: &ResolvedPos) -> Slice {
        let body = self.read_html(html);
        let options = ParseOptions {
            context: Some(context.clone()),
            ..Default::default()
        };
        let mut cx = ParseContext::new(self, &options, true, true);
        cx.add_all(&body, Vec::new());
        let fragment = cx.finish().into_fragment();
        if fragment.size() == 0 {
            return Slice::empty();
        }
        let mut slice = Slice::max_open(normalize_siblings(fragment, context), true);
        if slice.open_start > 0 || slice.open_end > 0 {
            let mut open_start = 0;
            let mut node = slice.content.first_child().cloned();
            while let Some(n) = node {
                if open_start >= slice.open_start || n.ty().spec().isolating {
                    break;
                }
                open_start += 1;
                node = n.first_child().cloned();
            }
            let mut open_end = 0;
            let mut node = slice.content.last_child().cloned();
            while let Some(n) = node {
                if open_end >= slice.open_end || n.ty().spec().isolating {
                    break;
                }
                open_end += 1;
                node = n.last_child().cloned();
            }
            slice = close_slice(slice, open_start, open_end);
        }
        slice
    }

    /// `html` read into an owned tree: its body, lists normalized.
    fn read_html(&self, html: &str) -> DomElement {
        let mut body = read_body(html);
        if self.normalize_lists {
            normalize_lists(&mut body);
        }
        body
    }

    fn match_tag(
        &self,
        dom: &DomElement,
        cx: &ParseContext<'_>,
        after: Option<usize>,
    ) -> Option<(usize, Option<Attrs>)> {
        let start = after.map_or(0, |a| a + 1);
        for (i, r) in self.tags.iter().enumerate().skip(start) {
            let Some(tag) = &r.rule.tag else { continue };
            if !dom.matches(tag) {
                continue;
            }
            if let Some(context) = &r.rule.context
                && !cx.matches_context(context)
            {
                continue;
            }
            let attrs = if let Some(get) = &r.rule.get_attrs {
                match (get.0)(RuleInput::Element(dom)) {
                    Some(a) => Some(a),
                    None => continue,
                }
            } else if let Some(from) = &r.rule.attrs_from {
                Some(attrs_from_dom(&r.target, from, dom, r.rule.attrs.as_ref()))
            } else {
                r.rule.attrs.clone()
            };
            let attrs = parsed_attrs(&r.target, dom, attrs);
            if !target_accepts(&r.target, attrs.as_ref()) {
                continue;
            }
            return Some((i, attrs));
        }
        None
    }

    fn match_style(
        &self,
        prop: &str,
        value: &str,
        cx: &ParseContext<'_>,
        after: Option<usize>,
    ) -> Option<(usize, Option<Attrs>)> {
        let start = after.map_or(0, |a| a + 1);
        for (i, r) in self.styles.iter().enumerate().skip(start) {
            let Some(style) = &r.rule.style else { continue };
            let style = style.to_ascii_lowercase();
            if !style.starts_with(prop) {
                continue;
            }
            if let Some(context) = &r.rule.context
                && !cx.matches_context(context)
            {
                continue;
            }
            if style.len() > prop.len() {
                let rest = &style[prop.len()..];
                match rest.strip_prefix('=') {
                    Some(expected) if expected.eq_ignore_ascii_case(value) => {}
                    _ => continue,
                }
            }
            let attrs = if let Some(get) = &r.rule.get_attrs {
                match (get.0)(RuleInput::Style(value)) {
                    Some(a) => Some(a),
                    None => continue,
                }
            } else {
                r.rule.attrs.clone()
            };
            if !target_accepts(&r.target, attrs.as_ref()) {
                continue;
            }
            return Some((i, attrs));
        }
        None
    }
}

/// Whether the type a rule creates takes `attrs` (required ones present).
fn target_accepts(target: &Target, attrs: Option<&Attrs>) -> bool {
    match target {
        Target::Node(ty) => ty.compute_attrs(attrs).is_ok(),
        Target::Mark(ty) => ty.create(attrs.cloned()).is_ok(),
        Target::None => true,
    }
}

/// `attrs` with the target's attributes read from `dom` as Tiptap's
/// `injectExtensionAttributesToParseRule` does: each attribute from its
/// `parse_html` place, by default the DOM attribute of its own name
/// ([`AttrParse::Skip`] opts out); values found override the rule's,
/// absent ones leave them.
fn parsed_attrs(target: &Target, dom: &DomElement, attrs: Option<Attrs>) -> Option<Attrs> {
    let specs = match target {
        Target::Node(ty) => ty.spec().attrs.as_slice(),
        Target::Mark(ty) => ty.spec().attrs.as_slice(),
        Target::None => return attrs,
    };
    let mut out = attrs;
    for (name, spec) in specs {
        let raw = match &spec.parse_html {
            None => dom.attr(name).map(str::to_owned),
            Some(AttrParse::Attribute(a)) => dom.attr(a).map(str::to_owned),
            Some(AttrParse::Style(p)) => dom.style(p),
            Some(AttrParse::Skip) => None,
        };
        let Some(raw) = raw else { continue };
        let value = match spec.validate {
            Some(kind @ (AttrType::Number | AttrType::Boolean)) => typed_value(kind, &raw),
            _ => Some(value_from_string(&raw)),
        };
        if let Some(value) = value {
            out.get_or_insert_with(Attrs::new)
                .insert(name.clone(), value);
        }
    }
    out
}

/// A DOM value as Tiptap's `fromString` reads it: `"true"` / `"false"` as
/// booleans, text matching `/^[+-]?(?:\d*\.)?\d+$/` as a number, other
/// text as it is.
fn value_from_string(raw: &str) -> Value {
    match raw {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let (int, frac) = match body.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (body, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let numeric = match frac {
        Some(frac) => digits(int) && !frac.is_empty() && digits(frac),
        None => !int.is_empty() && digits(int),
    };
    if !numeric {
        return Value::from(raw);
    }
    if frac.is_none()
        && let Ok(n) = raw.trim_start_matches('+').parse::<i64>()
    {
        return Value::from(n);
    }
    let lead = raw.trim_start_matches('+');
    let lead = match lead.strip_prefix('-') {
        Some(rest) if rest.starts_with('.') => format!("-0{rest}"),
        _ if lead.starts_with('.') => format!("0{lead}"),
        _ => lead.to_owned(),
    };
    lead.parse::<f64>()
        .map_or_else(|_| Value::from(raw), Value::from)
}

/// `raw` typed as an attribute of `kind` validates it; none for a number
/// that does not parse.
fn typed_value(kind: AttrType, raw: &str) -> Option<Value> {
    Some(match kind {
        AttrType::Number => match raw.trim().parse::<i64>() {
            Ok(n) => Value::from(n),
            Err(_) => Value::from(raw.trim().parse::<f64>().ok()?),
        },
        AttrType::Boolean => Value::Bool(raw != "false"),
        _ => Value::from(raw),
    })
}

/// The attributes `attrs_from` reads from `dom`, typed as the target's
/// attribute specs validate them, over the rule's fixed `base`.
fn attrs_from_dom(
    target: &Target,
    from: &std::collections::BTreeMap<String, String>,
    dom: &DomElement,
    base: Option<&Attrs>,
) -> Attrs {
    let specs = match target {
        Target::Node(ty) => ty.spec().attrs.as_slice(),
        Target::Mark(ty) => ty.spec().attrs.as_slice(),
        Target::None => &[],
    };
    let mut attrs = base.cloned().unwrap_or_default();
    for (name, dom_attr) in from {
        let Some(raw) = dom.attr(dom_attr) else {
            continue;
        };
        let kind = specs
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, s)| s.validate);
        let Some(value) = typed_value(kind.unwrap_or_default(), raw) else {
            continue;
        };
        attrs.insert(name.clone(), value);
    }
    attrs
}

/// The body of `html` as an owned tree. Clipboard HTML of Windows
/// (`CF_HTML`) starts with a header before the markup, dropped here.
fn read_body(html: &str) -> DomElement {
    // Only a header's lines (`Version:0.9`, `StartHTML:...`): text before
    // the first tag is content otherwise.
    let html = match html.trim_start().starts_with("Version:") {
        true => html.find('<').map_or("", |i| &html[i..]),
        false => html,
    };
    let dom = parse_document(RcDom::default(), ParseOpts::default()).one(html);
    let root = dom.document.clone();
    let html_el = child_named(&root, "html");
    let body = html_el
        .as_ref()
        .and_then(|h| child_named(h, "body"))
        .unwrap_or(root);
    let children = convert_children(&body, 0);
    DomElement::new("body", Vec::new(), children)
}

fn child_named(node: &Handle, name: &str) -> Option<Handle> {
    node.children
        .borrow()
        .iter()
        .find(|c| matches!(&c.data, NodeData::Element { name: n, .. } if &*n.local == name))
        .cloned()
}

fn convert_children(node: &Handle, depth: usize) -> Vec<DomNode> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    node.children
        .borrow()
        .iter()
        .filter_map(|child| match &child.data {
            NodeData::Text { contents } => Some(DomNode::Text(contents.borrow().to_string())),
            NodeData::Comment { .. } => Some(DomNode::Comment),
            NodeData::Element { name, attrs, .. } => {
                let attrs = attrs
                    .borrow()
                    .iter()
                    .map(|a| (a.name.local.to_string(), a.value.to_string()))
                    .collect();
                Some(DomNode::Element(DomElement::new(
                    name.local.to_string(),
                    attrs,
                    convert_children(child, depth + 1),
                )))
            }
            _ => None,
        })
        .collect()
}

/// Moves lists placed directly in a list into the item before them, as
/// some editors write nested lists (ProseMirror's `normalizeList`).
fn normalize_lists(el: &mut DomElement) {
    if LIST_TAGS.contains(&el.tag.as_str()) {
        let children = std::mem::take(&mut el.children);
        let mut prev_item: Option<usize> = None;
        for child in children {
            let name = child.as_element().map(|e| e.tag.clone());
            match name.as_deref() {
                Some(n) if LIST_TAGS.contains(&n) && prev_item.is_some() => {
                    let i = prev_item.expect("checked");
                    if let DomNode::Element(item) = &mut el.children[i] {
                        item.children.push(child);
                    }
                }
                Some("li") => {
                    prev_item = Some(el.children.len());
                    el.children.push(child);
                }
                Some(_) => {
                    prev_item = None;
                    el.children.push(child);
                }
                None => el.children.push(child),
            }
        }
    }
    for child in &mut el.children {
        if let DomNode::Element(e) = child {
            normalize_lists(e);
        }
    }
}

/// Whether a mark of `mark` may apply to a node of `node` somewhere in the
/// schema: some node allowing the mark can hold it.
fn mark_may_apply(mark: &MarkType, node: &NodeType) -> bool {
    for parent in node.schema().node_types() {
        if !parent.allows_mark_type(mark) {
            continue;
        }
        let mut seen: Vec<ContentMatch> = Vec::new();
        let mut stack = vec![parent.content_match()];
        while let Some(m) = stack.pop() {
            if seen.contains(&m) {
                continue;
            }
            seen.push(m.clone());
            for i in 0..m.edge_count() {
                let (ty, next) = m.edge(i);
                if &ty == node {
                    return true;
                }
                stack.push(next);
            }
        }
    }
    false
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct NodeContext {
    id: u64,
    ty: Option<NodeType>,
    attrs: Option<Attrs>,
    marks: Vec<Mark>,
    solid: bool,
    mtch: Option<ContentMatch>,
    options: u8,
    content: Vec<Node>,
}

impl NodeContext {
    fn new(
        ty: Option<NodeType>,
        attrs: Option<Attrs>,
        marks: Vec<Mark>,
        solid: bool,
        mtch: Option<ContentMatch>,
        options: u8,
    ) -> Self {
        let mtch = mtch.or_else(|| {
            if options & OPT_OPEN_LEFT != 0 {
                None
            } else {
                ty.as_ref().map(NodeType::content_match)
            }
        });
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            ty,
            attrs,
            marks,
            solid,
            mtch,
            options,
            content: Vec::new(),
        }
    }

    fn find_wrapping(&mut self, node: &Node) -> Option<Vec<NodeType>> {
        if self.mtch.is_none() {
            // Without a type, anything goes at the top of an open slice.
            let Some(ty) = self.ty.as_ref() else {
                return Some(Vec::new());
            };
            let start = ty.content_match();
            let single = Fragment::from(node.clone());
            if let Some(fill) = start.fill_before(&single, false, 0) {
                self.mtch = start.match_fragment(&fill, 0, fill.child_count());
            } else {
                let wrap = start.find_wrapping(node.ty())?;
                self.mtch = Some(start);
                return Some(wrap);
            }
        }
        self.mtch.as_ref()?.find_wrapping(node.ty())
    }

    fn finish(mut self, open_end: bool) -> Finished {
        if self.options & OPT_PRESERVE_WS == 0
            && let Some(last) = self.content.last()
            && let Some(text) = last.text()
        {
            let trimmed = text.trim_end_matches(is_ws);
            if trimmed.len() != text.len() {
                if trimmed.is_empty() {
                    self.content.pop();
                } else {
                    let node = last.with_text(trimmed);
                    *self.content.last_mut().expect("checked") = node;
                }
            }
        }
        let mut content = Fragment::from(self.content);
        if !open_end
            && let Some(m) = &self.mtch
            && let Some(fill) = m.fill_before(&Fragment::empty(), true, 0)
        {
            content = content.append(&fill);
        }
        match &self.ty {
            Some(ty) => match ty.create(self.attrs, content.clone(), self.marks) {
                Ok(node) => Finished::Node(node),
                Err(e) => {
                    log::warn!("parsed {} dropped: {e}", ty.name());
                    Finished::Fragment(content)
                }
            },
            None => Finished::Fragment(content),
        }
    }

    fn inline_context(&self, parent_tag: Option<&str>) -> bool {
        if let Some(ty) = &self.ty {
            return ty.inline_content();
        }
        if let Some(first) = self.content.first() {
            return first.is_inline();
        }
        parent_tag.is_some_and(|t| !BLOCK_TAGS.contains(&t))
    }
}

enum Finished {
    Node(Node),
    Fragment(Fragment),
}

impl Finished {
    fn into_fragment(self) -> Fragment {
        match self {
            Self::Node(node) => Fragment::from(node),
            Self::Fragment(f) => f,
        }
    }
}

/// Where a DOM node sits among its siblings.
#[derive(Clone, Copy)]
struct Place<'d> {
    parent_tag: Option<&'d str>,
    prev_is_br: bool,
    is_last: bool,
}

struct ParseContext<'p> {
    parser: &'p DomParser,
    options: &'p ParseOptions,
    is_open: bool,
    clipboard: bool,
    open: usize,
    nodes: Vec<NodeContext>,
    needs_block: bool,
    local_preserve_ws: bool,
}

impl<'p> ParseContext<'p> {
    fn new(
        parser: &'p DomParser,
        options: &'p ParseOptions,
        is_open: bool,
        clipboard: bool,
    ) -> Self {
        let top_options = ws_options_for(None, options.preserve_whitespace, 0)
            | if is_open { OPT_OPEN_LEFT } else { 0 };
        let top = if let Some(top) = &options.top_node {
            NodeContext::new(
                Some(top.ty().clone()),
                Some(top.attrs().clone()),
                Vec::new(),
                true,
                Some(
                    options
                        .top_match
                        .clone()
                        .unwrap_or_else(|| top.ty().content_match()),
                ),
                top_options,
            )
        } else if is_open {
            NodeContext::new(None, None, Vec::new(), true, None, top_options)
        } else {
            NodeContext::new(
                Some(parser.schema.top_node_type()),
                None,
                Vec::new(),
                true,
                None,
                top_options,
            )
        };
        Self {
            parser,
            options,
            is_open,
            clipboard,
            open: 0,
            nodes: vec![top],
            needs_block: false,
            local_preserve_ws: false,
        }
    }

    fn top(&self) -> &NodeContext {
        &self.nodes[self.open]
    }

    fn add_all(&mut self, parent: &DomElement, marks: Vec<Mark>) {
        let count = parent.children.len();
        for (i, child) in parent.children.iter().enumerate() {
            let place = Place {
                parent_tag: Some(parent.tag_name()),
                prev_is_br: i > 0
                    && parent.children[i - 1]
                        .as_element()
                        .is_some_and(|e| e.tag == "br"),
                is_last: i + 1 == count,
            };
            match child {
                DomNode::Text(text) => self.add_text(text, place, &marks),
                DomNode::Element(el) => self.add_element(el, place, marks.clone(), None),
                DomNode::Comment => {}
            }
        }
    }

    fn add_text(&mut self, value: &str, place: Place<'_>, marks: &[Mark]) {
        let schema = self.parser.schema.clone();
        let top = self.top();
        let preserve = if top.options & OPT_PRESERVE_WS_FULL != 0 {
            Whitespace::Full
        } else if self.local_preserve_ws || top.options & OPT_PRESERVE_WS != 0 {
            Whitespace::Preserve
        } else {
            Whitespace::Collapse
        };
        if !(preserve == Whitespace::Full
            || top.inline_context(place.parent_tag)
            || has_non_ws(value))
        {
            return;
        }
        let mut value = value.to_owned();
        match preserve {
            Whitespace::Collapse => {
                value = collapse_ws(&value);
                if value.starts_with(' ') && self.open == self.nodes.len() - 1 {
                    let before = top.content.last();
                    let strip = match before {
                        None => true,
                        Some(b) => place.prev_is_br || b.text().is_some_and(|t| t.ends_with(is_ws)),
                    };
                    if strip {
                        value.remove(0);
                    }
                }
            }
            Whitespace::Full => value = value.replace("\r\n", "\n").replace('\r', "\n"),
            Whitespace::Preserve => {
                let lb = schema
                    .linebreak_replacement()
                    .filter(|_| value.contains(['\r', '\n']))
                    .and_then(|ty| ty.create(None, Fragment::empty(), vec![]).ok());
                let fits = match &lb {
                    Some(node) => {
                        let open = self.open;
                        self.nodes[open].find_wrapping(node).is_some()
                    }
                    None => false,
                };
                if let (Some(lb), true) = (lb, fits) {
                    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
                    for (i, line) in normalized.split('\n').enumerate() {
                        if i > 0 {
                            self.insert_node(lb.clone(), marks.to_vec(), true);
                        }
                        if !line.is_empty() {
                            self.insert_node(
                                schema.text(line, vec![]),
                                marks.to_vec(),
                                !has_non_ws(line),
                            );
                        }
                    }
                    value.clear();
                } else {
                    value = value.replace("\r\n", " ").replace(['\r', '\n'], " ");
                }
            }
        }
        if !value.is_empty() {
            let cautious = !has_non_ws(&value);
            self.insert_node(schema.text(&value, vec![]), marks.to_vec(), cautious);
        }
    }

    fn add_element(
        &mut self,
        dom: &DomElement,
        place: Place<'_>,
        marks: Vec<Mark>,
        match_after: Option<usize>,
    ) {
        let outer_ws = self.local_preserve_ws;
        let mut top_id = self.top().id;
        let name = dom.tag_name();
        if name == "pre" || dom.style("white-space").is_some_and(|v| v.contains("pre")) {
            self.local_preserve_ws = true;
        }
        // Pasted HTML: a block's trailing `<br>` is the browser's
        // placeholder, not a line break.
        let clipboard_ignore = self.clipboard
            && name == "br"
            && place.is_last
            && place
                .parent_tag
                .is_some_and(|p| !INLINE_PARENTS.contains(&p));
        let rule = if clipboard_ignore {
            None
        } else {
            self.parser.match_tag(dom, self, match_after)
        };
        let parser = self.parser;
        let rule_ref = rule.as_ref().map(|(i, _)| &parser.tags[*i]);
        let ignored = clipboard_ignore
            || match rule_ref {
                Some(r) => r.rule.ignore,
                None => IGNORE_TAGS.contains(&name),
            };
        if ignored {
            self.ignore_fallback(dom, marks);
        } else if rule_ref
            .is_none_or(|r| r.rule.skip || r.rule.close_parent || matches!(r.target, Target::None))
        {
            if rule_ref.is_some_and(|r| r.rule.close_parent) {
                self.open = self.open.saturating_sub(1);
            }
            let mut sync = false;
            let old_needs_block = self.needs_block;
            if BLOCK_TAGS.contains(&name) {
                let top = self.top();
                if top.content.first().is_some_and(Node::is_inline) && self.open > 0 {
                    self.open -= 1;
                }
                top_id = self.top().id;
                sync = true;
                if self.top().ty.is_none() {
                    self.needs_block = true;
                }
            } else if dom.children.is_empty() {
                self.leaf_fallback(dom, &marks);
                self.local_preserve_ws = outer_ws;
                return;
            }
            let inner = if rule_ref.is_some_and(|r| r.rule.skip) {
                Some(marks)
            } else {
                self.read_styles(dom, marks)
            };
            if let Some(inner) = inner {
                self.add_all(dom, inner);
            }
            if sync {
                self.sync(top_id);
            }
            self.needs_block = old_needs_block;
        } else if let Some((index, attrs)) = rule
            && let Some(inner) = self.read_styles(dom, marks)
        {
            let continue_after =
                (parser.tags[index].rule.consuming == Some(false)).then_some(index);
            self.add_element_by_rule(dom, place, index, attrs, inner, continue_after);
        }
        self.local_preserve_ws = outer_ws;
    }

    /// A `<br>` no rule takes still breaks the line in a textblock.
    fn leaf_fallback(&mut self, dom: &DomElement, marks: &[Mark]) {
        if dom.tag_name() == "br" && self.top().ty.as_ref().is_some_and(NodeType::inline_content) {
            let place = Place {
                parent_tag: None,
                prev_is_br: false,
                is_last: true,
            };
            self.add_text("\n", place, marks);
        }
    }

    /// An ignored `<br>` still makes an inline context.
    fn ignore_fallback(&mut self, dom: &DomElement, marks: Vec<Mark>) {
        if dom.tag_name() == "br" && !self.top().ty.as_ref().is_some_and(NodeType::inline_content) {
            let probe = self.parser.schema.text("-", vec![]);
            self.find_place(&probe, marks, true);
        }
    }

    /// `marks` with those of the element's styles; none when a style rule
    /// ignores the element.
    fn read_styles(&mut self, dom: &DomElement, mut marks: Vec<Mark>) -> Option<Vec<Mark>> {
        if !dom.has_attr("style") {
            return Some(marks);
        }
        let styles = dom.styles();
        if styles.is_empty() {
            return Some(marks);
        }
        let parser = self.parser;
        for prop in parser.matched_styles.iter() {
            let Some(value) = styles.get(prop) else {
                continue;
            };
            let mut after = None;
            while let Some((index, attrs)) = parser.match_style(prop, value, self, after) {
                let rule = &parser.styles[index];
                if rule.rule.ignore {
                    return None;
                }
                if let Some(clear) = &rule.rule.clear_mark {
                    marks.retain(|m| !(clear.0)(m));
                } else if let Target::Mark(ty) = &rule.target
                    && let Ok(mark) = ty.create(attrs)
                {
                    marks.push(mark);
                }
                if rule.rule.consuming == Some(false) {
                    after = Some(index);
                } else {
                    break;
                }
            }
        }
        Some(marks)
    }

    fn add_element_by_rule(
        &mut self,
        dom: &DomElement,
        place: Place<'_>,
        index: usize,
        attrs: Option<Attrs>,
        mut marks: Vec<Mark>,
        continue_after: Option<usize>,
    ) {
        let parser = self.parser;
        let rule = &parser.tags[index];
        let mut sync = false;
        let mut leaf = false;
        match &rule.target {
            Target::Node(ty) if !ty.is_leaf() => {
                if let Some(inner) = self.enter(
                    ty.clone(),
                    attrs,
                    marks.clone(),
                    rule.rule.preserve_whitespace,
                ) {
                    sync = true;
                    marks = inner;
                }
            }
            Target::Node(ty) => {
                leaf = true;
                let inserted = match ty.create(attrs, Fragment::empty(), vec![]) {
                    Ok(node) => self.insert_node(node, marks.clone(), dom.tag_name() == "br"),
                    Err(_) => false,
                };
                if !inserted {
                    self.leaf_fallback(dom, &marks);
                }
            }
            Target::Mark(ty) => {
                if let Ok(mark) = ty.create(attrs) {
                    marks.push(mark);
                }
            }
            Target::None => {}
        }
        let start_in = self.top().id;
        if leaf {
            // A leaf's DOM content is not read.
        } else if let Some(after) = continue_after {
            self.add_element(dom, place, marks, Some(after));
        } else {
            let content = rule
                .rule
                .content_element
                .as_deref()
                .and_then(|s| dom.query_selector(s))
                .unwrap_or(dom);
            self.add_all(content, marks);
        }
        if sync && self.sync(start_in) {
            self.open -= 1;
        }
    }

    /// Places `node` in the open node that takes it with the fewest
    /// wrappers, entering them; the marks left to apply, none when nothing
    /// takes it.
    fn find_place(&mut self, node: &Node, marks: Vec<Mark>, cautious: bool) -> Option<Vec<Mark>> {
        let mut route: Option<Vec<NodeType>> = None;
        let mut sync = None;
        let mut penalty = 0;
        for depth in (0..=self.open).rev() {
            let cx = &mut self.nodes[depth];
            if let Some(found) = cx.find_wrapping(node)
                && route
                    .as_ref()
                    .is_none_or(|r| r.len() > found.len() + penalty)
            {
                let done = found.is_empty();
                route = Some(found);
                sync = Some(cx.id);
                if done {
                    break;
                }
            }
            if cx.solid {
                if cautious {
                    break;
                }
                penalty += 2;
            }
        }
        let route = route?;
        self.sync(sync.expect("set with route"));
        let mut marks = marks;
        for ty in route {
            marks = self.enter_inner(ty, None, marks, false, None);
        }
        Some(marks)
    }

    fn insert_node(&mut self, node: Node, mut marks: Vec<Mark>, cautious: bool) -> bool {
        if node.is_inline()
            && self.needs_block
            && self.top().ty.is_none()
            && let Some(block) = self.textblock_from_context()
        {
            marks = self.enter_inner(block, None, marks, false, None);
        }
        let Some(inner) = self.find_place(&node, marks, cautious) else {
            return false;
        };
        self.close_extra(false);
        let open = self.open;
        let top = &mut self.nodes[open];
        if let Some(m) = &top.mtch {
            top.mtch = m.match_type(node.ty());
        }
        let mut node_marks: Vec<Mark> = Vec::new();
        for m in inner.iter().chain(node.marks()) {
            let allowed = match &top.ty {
                Some(ty) => ty.allows_mark_type(m.ty()),
                None => mark_may_apply(m.ty(), node.ty()),
            };
            if allowed {
                node_marks = m.add_to_set(&node_marks);
            }
        }
        top.content.push(node.mark(node_marks));
        true
    }

    /// Enters a node of `ty` where it fits; the marks left to apply inside,
    /// none when it fits nowhere.
    fn enter(
        &mut self,
        ty: NodeType,
        attrs: Option<Attrs>,
        marks: Vec<Mark>,
        preserve: Option<Whitespace>,
    ) -> Option<Vec<Mark>> {
        let probe = ty.create(attrs.clone(), Fragment::empty(), vec![]).ok()?;
        self.find_place(&probe, marks.clone(), false)?;
        Some(self.enter_inner(ty, attrs, marks, true, preserve))
    }

    fn enter_inner(
        &mut self,
        ty: NodeType,
        attrs: Option<Attrs>,
        marks: Vec<Mark>,
        solid: bool,
        preserve: Option<Whitespace>,
    ) -> Vec<Mark> {
        self.close_extra(false);
        let open = self.open;
        let top = &mut self.nodes[open];
        top.mtch = top.mtch.as_ref().and_then(|m| m.match_type(&ty));
        let mut options = ws_options_for(Some(&ty), preserve, top.options);
        if top.options & OPT_OPEN_LEFT != 0 && top.content.is_empty() {
            options |= OPT_OPEN_LEFT;
        }
        let mut apply: Vec<Mark> = Vec::new();
        let top_ty = top.ty.clone();
        let rest = marks
            .into_iter()
            .filter(|m| {
                let allowed = match &top_ty {
                    Some(t) => t.allows_mark_type(m.ty()),
                    None => mark_may_apply(m.ty(), &ty),
                };
                if allowed {
                    apply = m.add_to_set(&apply);
                }
                !allowed
            })
            .collect();
        self.nodes.push(NodeContext::new(
            Some(ty),
            attrs,
            apply,
            solid,
            None,
            options,
        ));
        self.open += 1;
        rest
    }

    /// Closes the nodes above the open one into their parents.
    fn close_extra(&mut self, open_end: bool) {
        while self.nodes.len() > self.open + 1 {
            let cx = self.nodes.pop().expect("checked");
            let parent = self.nodes.last_mut().expect("the top context stays");
            match cx.finish(open_end) {
                Finished::Node(node) => parent.content.push(node),
                Finished::Fragment(f) => parent.content.extend(f.iter().cloned()),
            }
        }
    }

    fn finish(mut self) -> Finished {
        self.open = 0;
        self.close_extra(self.is_open);
        let top_open = self.is_open || self.options.top_open;
        self.nodes.pop().expect("the top context").finish(top_open)
    }

    /// Makes the context `id` the open one; `false` when it was closed.
    fn sync(&mut self, id: u64) -> bool {
        for i in (0..=self.open).rev() {
            if self.nodes[i].id == id {
                self.open = i;
                return true;
            } else if self.local_preserve_ws {
                self.nodes[i].options |= OPT_PRESERVE_WS;
            }
        }
        false
    }

    /// The textblock loose inline content goes in: the default one where
    /// the content lands, else the schema's first.
    fn textblock_from_context(&self) -> Option<NodeType> {
        if let Some(cx) = &self.options.context {
            for d in (0..=cx.depth).rev() {
                let deflt = cx
                    .node(d)
                    .content_match_at(cx.index_after(d))
                    .and_then(|m| m.default_type());
                if let Some(ty) = deflt
                    && ty.is_textblock()
                    && !ty.has_required_attrs()
                {
                    return Some(ty);
                }
            }
        }
        self.parser
            .schema
            .node_types()
            .into_iter()
            .find(|ty| ty.is_textblock() && !ty.has_required_attrs())
    }

    /// Whether a rule's `context` matches the open nodes (and, below them,
    /// the ancestors of the options' context).
    fn matches_context(&self, context: &str) -> bool {
        if context.contains('|') {
            return context.split('|').any(|c| self.matches_context(c.trim()));
        }
        let parts: Vec<&str> = context.split('/').collect();
        let option = self.options.context.as_ref();
        let use_root = !self.is_open
            && option.is_none_or(|o| Some(o.parent().ty()) == self.nodes[0].ty.as_ref());
        let min_depth: i64 =
            -(option.map_or(0, |o| o.depth as i64 + 1)) + if use_root { 0 } else { 1 };
        self.match_parts(
            &parts,
            parts.len() as i64 - 1,
            self.open as i64,
            min_depth,
            use_root,
        )
    }

    fn match_parts(
        &self,
        parts: &[&str],
        mut i: i64,
        mut depth: i64,
        min_depth: i64,
        use_root: bool,
    ) -> bool {
        let option = self.options.context.as_ref();
        while i >= 0 {
            let part = parts[i as usize];
            if part.is_empty() {
                if i == parts.len() as i64 - 1 || i == 0 {
                    i -= 1;
                    continue;
                }
                while depth >= min_depth {
                    if self.match_parts(parts, i - 1, depth, min_depth, use_root) {
                        return true;
                    }
                    depth -= 1;
                }
                return false;
            }
            let next = if depth > 0 || (depth == 0 && use_root) {
                self.nodes.get(depth as usize).and_then(|n| n.ty.clone())
            } else if let Some(o) = option
                && depth >= min_depth
            {
                Some(o.node((depth - min_depth) as usize).ty().clone())
            } else {
                None
            };
            match next {
                Some(ty) if ty.name() == part || ty.is_in_group(part) => depth -= 1,
                _ => return false,
            }
            i -= 1;
        }
        true
    }
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// Wraps the top-level nodes of a pasted fragment so they fit at
/// `context` together: list items in a list, cells in a row
/// (ProseMirror's `normalizeSiblings`).
fn normalize_siblings(fragment: Fragment, context: &ResolvedPos) -> Fragment {
    if fragment.child_count() < 2 {
        return fragment;
    }
    for d in (0..=context.depth).rev() {
        let parent = context.node(d);
        let Some(mut mtch) = parent.content_match_at(context.index(d)) else {
            continue;
        };
        let mut last_wrap: Vec<NodeType> = Vec::new();
        let mut result: Vec<Node> = Vec::new();
        let mut ok = true;
        for node in fragment.iter() {
            let Some(wrap) = mtch.find_wrapping(node.ty()) else {
                ok = false;
                break;
            };
            let in_last = if !result.is_empty() && !last_wrap.is_empty() {
                add_to_sibling(&wrap, &last_wrap, node, result.last().expect("checked"), 0)
            } else {
                None
            };
            if let Some(in_last) = in_last {
                *result.last_mut().expect("checked") = in_last;
            } else {
                if let Some(last) = result.last_mut() {
                    *last = close_right(last, last_wrap.len());
                }
                let wrapped = with_wrappers(node.clone(), &wrap, 0);
                let Some(next) = mtch.match_type(wrapped.ty()) else {
                    ok = false;
                    break;
                };
                mtch = next;
                result.push(wrapped);
                last_wrap = wrap;
            }
        }
        if ok {
            return Fragment::from(result);
        }
    }
    fragment
}

fn with_wrappers(mut node: Node, wrap: &[NodeType], from: usize) -> Node {
    for ty in wrap[from..].iter().rev() {
        match ty.create(None, Fragment::from(node.clone()), vec![]) {
            Ok(n) => node = n,
            Err(_) => break,
        }
    }
    node
}

fn add_to_sibling(
    wrap: &[NodeType],
    last_wrap: &[NodeType],
    node: &Node,
    sibling: &Node,
    depth: usize,
) -> Option<Node> {
    if depth < wrap.len() && depth < last_wrap.len() && wrap[depth] == last_wrap[depth] {
        if let Some(last) = sibling.last_child()
            && let Some(inner) = add_to_sibling(wrap, last_wrap, node, last, depth + 1)
        {
            return Some(
                sibling.copy(
                    sibling
                        .content()
                        .replace_child(sibling.child_count() - 1, inner),
                ),
            );
        }
        let m = sibling.content_match_at(sibling.child_count())?;
        let want = if depth == wrap.len() - 1 {
            node.ty().clone()
        } else {
            wrap[depth + 1].clone()
        };
        if m.match_type(&want).is_some() {
            return Some(
                sibling.copy(sibling.content().append(&Fragment::from(with_wrappers(
                    node.clone(),
                    wrap,
                    depth + 1,
                )))),
            );
        }
    }
    None
}

fn close_right(node: &Node, depth: usize) -> Node {
    if depth == 0 {
        return node.clone();
    }
    let Some(last) = node.last_child() else {
        return node.clone();
    };
    let fragment = node
        .content()
        .replace_child(node.child_count() - 1, close_right(last, depth - 1));
    let fill = node
        .content_match_at(node.child_count())
        .and_then(|m| m.fill_before(&Fragment::empty(), true, 0))
        .unwrap_or_else(Fragment::empty);
    node.copy(fragment.append(&fill))
}

fn close_range(
    fragment: &Fragment,
    side: i32,
    from: usize,
    to: usize,
    depth: usize,
    mut open_end: usize,
) -> Fragment {
    let node = if side < 0 {
        fragment.first_child()
    } else {
        fragment.last_child()
    };
    let Some(node) = node else {
        return fragment.clone();
    };
    let mut inner = node.content().clone();
    if fragment.child_count() > 1 {
        open_end = 0;
    }
    if depth + 1 < to {
        inner = close_range(&inner, side, from, to, depth + 1, open_end);
    }
    if depth >= from {
        inner = if side < 0 {
            node.ty()
                .content_match()
                .fill_before(&inner, open_end <= depth, 0)
                .map_or(inner.clone(), |f| f.append(&inner))
        } else {
            let fill = node
                .ty()
                .content_match()
                .match_fragment(&inner, 0, inner.child_count())
                .and_then(|m| m.fill_before(&Fragment::empty(), true, 0))
                .unwrap_or_else(Fragment::empty);
            inner.append(&fill)
        };
    }
    let index = if side < 0 {
        0
    } else {
        fragment.child_count() - 1
    };
    fragment.replace_child(index, node.copy(inner))
}

/// `slice` closed to `open_start` / `open_end` (ProseMirror's `closeSlice`).
fn close_slice(slice: Slice, open_start: usize, open_end: usize) -> Slice {
    let mut slice = slice;
    if open_start < slice.open_start {
        slice = Slice::new(
            close_range(
                &slice.content,
                -1,
                open_start,
                slice.open_start,
                0,
                slice.open_end,
            ),
            open_start,
            slice.open_end,
        );
    }
    if open_end < slice.open_end {
        slice = Slice::new(
            close_range(&slice.content, 1, open_end, slice.open_end, 0, 0),
            slice.open_start,
            open_end,
        );
    }
    slice
}

#[cfg(test)]
mod from_string_tests {
    use super::*;

    #[test]
    fn from_string_is_tiptaps() {
        assert_eq!(value_from_string("+1"), Value::from(1));
        assert_eq!(value_from_string("-2"), Value::from(-2));
        assert_eq!(value_from_string(".5"), Value::from(0.5));
        assert_eq!(value_from_string("-.5"), Value::from(-0.5));
        assert_eq!(value_from_string("1.25"), Value::from(1.25));
        assert_eq!(value_from_string("1e5"), Value::from("1e5"));
        assert_eq!(value_from_string("1."), Value::from("1."));
        assert_eq!(value_from_string(" 1"), Value::from(" 1"));
        assert_eq!(value_from_string("true"), Value::Bool(true));
        assert_eq!(value_from_string(""), Value::from(""));
    }
}

#[cfg(test)]
mod tests;
