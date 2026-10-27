//! Schemas: the node and mark types a document may hold, their attributes,
//! content expressions and allowed marks (`prosemirror-model`'s `schema.ts`).

use std::{
    any::Any,
    collections::HashMap,
    fmt,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

use serde_json::Value;

use super::{
    AttrParse, AttrRender, Attrs, DomOutputSpec, Fragment, Mark, Node, ParseRule, TextRender,
    Whitespace,
    content::{self, ContentMatch, MatchState},
};

/// What went wrong defining a schema or building or checking a node with it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SchemaError {
    /// The schema's spec is invalid (a missing `text` or top node type, a
    /// name used twice, an unknown mark or group, ...).
    Spec(String),
    /// A node type's content expression does not parse or has a dead end.
    ContentExpr {
        /// The node type whose expression it is.
        node: String,
        /// What is wrong with it.
        message: String,
    },
    /// No node or mark type of this name.
    UnknownType(String),
    /// A missing, unsupported or invalid attribute.
    Attr(String),
    /// A node's content, or its marks, do not match its type.
    InvalidContent(String),
    /// JSON that does not describe a node, mark, fragment, slice or schema.
    Json(String),
}

impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spec(m) | Self::Attr(m) | Self::InvalidContent(m) | Self::Json(m) => {
                f.write_str(m)
            }
            Self::ContentExpr { node, message } => {
                write!(f, "{message} (in content expression of {node})")
            }
            Self::UnknownType(name) => write!(f, "Unknown node or mark type {name}"),
        }
    }
}

impl std::error::Error for SchemaError {}

/// The type an attribute's values must have, checked by `check()` and
/// `from_json`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AttrType {
    /// A JSON string.
    String,
    /// A JSON number.
    Number,
    /// A JSON boolean.
    Boolean,
    /// Any value.
    #[default]
    Any,
}

impl AttrType {
    fn accepts(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Number => value.is_number(),
            Self::Boolean => value.is_boolean(),
            Self::Any => true,
        }
    }
}

/// An attribute of a node or mark type.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct AttrSpec {
    /// The value used when none is given; without one the attribute is
    /// required.
    pub default: Option<Value>,
    /// The type values must have. `null` also passes when it is the default.
    pub validate: Option<AttrType>,
    /// Where the tag rules of its type read it from in HTML (Tiptap's
    /// `parseHTML`); none reads the DOM attribute of its own name, as
    /// Tiptap does, [`AttrParse::Skip`] nothing.
    pub parse_html: Option<AttrParse>,
    /// Where it is written in HTML, merged into the outer element its type
    /// renders (Tiptap's `renderHTML`); none writes the DOM attribute of
    /// its own name, as Tiptap does, [`AttrRender::Skip`] nothing (the
    /// type's `to_dom` may still write it).
    pub render_html: Option<AttrRender>,
    /// Whether a node split in two keeps it in the second half (Tiptap's
    /// `keepOnSplit`, default true).
    pub keep_on_split: bool,
    /// Whether it is rendered to HTML at all (Tiptap's `rendered`, default
    /// true).
    pub rendered: bool,
}

impl Default for AttrSpec {
    fn default() -> Self {
        Self {
            default: None,
            validate: None,
            parse_html: None,
            render_html: None,
            keep_on_split: true,
            rendered: true,
        }
    }
}

/// A node type's definition.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct NodeSpec {
    /// The content expression (`"paragraph+"`, `"inline*"`, ...); none is a
    /// leaf.
    pub content: Option<String>,
    /// The marks allowed in its content: `"_"` all, `""` none, else names or
    /// groups separated by spaces. By default all marks for inline content,
    /// none otherwise.
    pub marks: Option<String>,
    /// The groups it belongs to, separated by spaces.
    pub group: Option<String>,
    /// Whether it is inline (`text` always is).
    pub inline: bool,
    /// Whether it is edited as a unit though it has content.
    pub atom: bool,
    /// Whether a node selection may select it.
    pub selectable: bool,
    /// Whether the sides of a node of this type are boundaries editing does
    /// not cross (table cells).
    pub isolating: bool,
    /// Whether its content is code (whitespace kept, no smart input).
    pub code: bool,
    /// Whether it is kept when its content is replaced, and its type is kept
    /// when its content is pasted elsewhere (headings, list items).
    pub defining: bool,
    /// Its attributes, in order.
    pub attrs: Vec<(String, AttrSpec)>,
    /// The text a leaf of this type counts as in `text_content` and
    /// `text_between` (ProseMirror's `leafText`, as a constant).
    pub leaf_text: Option<String>,
    /// How whitespace in its content is treated: `"pre"` or `"normal"`;
    /// by default `"pre"` for code, else `"normal"`.
    pub whitespace: Option<String>,
    /// Overrides `defining` for keeping the node when its content is
    /// replaced.
    pub defining_as_context: Option<bool>,
    /// Overrides `defining` for keeping its type when its content is pasted.
    pub defining_for_content: Option<bool>,
    /// Whether a view may drag nodes of this type without selecting them.
    pub draggable: bool,
    /// Whether it is the inline leaf that stands for a line break when a
    /// textblock converts to code (at most one type per schema).
    pub linebreak_replacement: bool,
    /// How HTML becomes nodes of this type
    /// ([`DomParser`](crate::rich_editor::formats::DomParser)).
    pub parse_dom: Vec<ParseRule>,
    /// How nodes of this type render as HTML (ProseMirror's `toDOM`); none
    /// renders a `<div data-type="name">` (a `<span>` when inline).
    pub to_dom: Option<DomOutputSpec>,
    /// The text nodes of this type count as in plain text (Tiptap's
    /// `renderText`); none counts their content.
    pub render_text: Option<TextRender>,
    /// Free-form metadata for frameworks built on the kernel (unknown keys
    /// of the JSON form land here).
    pub extra: Attrs,
}

impl Default for NodeSpec {
    fn default() -> Self {
        Self {
            content: None,
            marks: None,
            group: None,
            inline: false,
            atom: false,
            selectable: true,
            isolating: false,
            code: false,
            defining: false,
            attrs: Vec::new(),
            leaf_text: None,
            whitespace: None,
            defining_as_context: None,
            defining_for_content: None,
            draggable: false,
            linebreak_replacement: false,
            parse_dom: Vec::new(),
            to_dom: None,
            render_text: None,
            extra: Attrs::new(),
        }
    }
}

/// A mark type's definition.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct MarkSpec {
    /// Its attributes, in order.
    pub attrs: Vec<(String, AttrSpec)>,
    /// Whether text typed at its end gets it.
    pub inclusive: bool,
    /// The marks it cannot coexist with, names or groups separated by
    /// spaces (`"_"` all); none means only itself, `""` none at all.
    pub excludes: Option<String>,
    /// The groups it belongs to, separated by spaces.
    pub group: Option<String>,
    /// Whether it spans several nodes when serialized.
    pub spanning: bool,
    /// How HTML elements and styles become marks of this type
    /// ([`DomParser`](crate::rich_editor::formats::DomParser)).
    pub parse_dom: Vec<ParseRule>,
    /// How marks of this type render as HTML (ProseMirror's `toDOM`); none
    /// renders a `<span data-mark="name">`.
    pub to_dom: Option<DomOutputSpec>,
    /// Whether the caret can leave the mark at its end with the arrow key
    /// (Tiptap's `exitable`).
    pub exitable: bool,
    /// Whether the mark carries on into a new block when a block is split
    /// (Tiptap's `keepOnSplit`, default true).
    pub keep_on_split: bool,
    /// Whether its content is code (ProseMirror's mark spec `code`): input
    /// rules and smart input leave it alone.
    pub code: bool,
    /// Free-form metadata for frameworks built on the kernel (unknown keys
    /// of the JSON form land here).
    pub extra: Attrs,
}

impl Default for MarkSpec {
    fn default() -> Self {
        Self {
            attrs: Vec::new(),
            inclusive: true,
            excludes: None,
            group: None,
            spanning: true,
            parse_dom: Vec::new(),
            to_dom: None,
            exitable: false,
            keep_on_split: true,
            code: false,
            extra: Attrs::new(),
        }
    }
}

/// A schema's definition. Order matters: the first block type of a group is
/// the one filling required content, the order of marks is the order of
/// mark sets.
#[derive(Clone, Debug, Default, PartialEq)]
#[non_exhaustive]
pub struct SchemaSpec {
    /// The node types, in order.
    pub nodes: Vec<(String, NodeSpec)>,
    /// The mark types, in order.
    pub marks: Vec<(String, MarkSpec)>,
    /// The type of documents; `"doc"` by default.
    pub top_node: Option<String>,
}

fn json_err(msg: impl Into<String>) -> SchemaError {
    SchemaError::Json(msg.into())
}

/// The entries of `nodes` / `marks`: an array of `[name, spec]` pairs, or an
/// object in its iteration order (key order only survives when serde_json
/// preserves it; otherwise its keys come sorted, so use the array form when
/// order matters).
fn entries(value: Option<&Value>) -> Result<Vec<(String, &Value)>, SchemaError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(map)) => Ok(map.iter().map(|(k, v)| (k.clone(), v)).collect()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item.as_array().map(Vec::as_slice) {
                Some([Value::String(name), spec]) => Ok((name.clone(), spec)),
                _ => Err(json_err("Expected [name, spec] pairs")),
            })
            .collect(),
        Some(_) => Err(json_err(
            "Expected an object or an array of [name, spec] pairs",
        )),
    }
}

fn str_field(spec: &Value, key: &str) -> Result<Option<String>, SchemaError> {
    match spec.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(json_err(format!("{key} must be a string"))),
    }
}

fn bool_field(spec: &Value, key: &str, default: bool) -> Result<bool, SchemaError> {
    match spec.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(json_err(format!("{key} must be a boolean"))),
    }
}

fn opt_bool(spec: &Value, key: &str) -> Result<Option<bool>, SchemaError> {
    match spec.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(json_err(format!("{key} must be a boolean"))),
    }
}

fn extra(spec: &Value, known: &[&str]) -> Attrs {
    spec.as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| !known.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

const NODE_KEYS: &[&str] = &[
    "content",
    "marks",
    "group",
    "inline",
    "atom",
    "selectable",
    "isolating",
    "code",
    "defining",
    "attrs",
    "leafText",
    "whitespace",
    "definingAsContext",
    "definingForContent",
    "draggable",
    "linebreakReplacement",
    "parseDOM",
    "toDOM",
    "renderText",
];
const MARK_KEYS: &[&str] = &[
    "attrs",
    "inclusive",
    "excludes",
    "group",
    "spanning",
    "parseDOM",
    "toDOM",
    "exitable",
    "keepOnSplit",
];

/// `parseDOM`: an array of rule objects (`tag`, `style`, `priority`,
/// `consuming`, `context`, `node`, `mark`, `attrs`, `getAttrs` as
/// `{attr: "dom-attribute"}`, `ignore`, `skip`, `closeParent`,
/// `preserveWhitespace` (`true`, `false` or `"full"`), `contentElement`).
fn parse_dom_from_json(spec: &Value) -> Result<Vec<ParseRule>, SchemaError> {
    let rules = match spec.get("parseDOM") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(rules)) => rules,
        Some(_) => return Err(json_err("parseDOM must be an array")),
    };
    rules
        .iter()
        .map(|r| {
            if !r.is_object() {
                return Err(json_err("parseDOM rules must be objects"));
            }
            let priority = match r.get("priority") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_i64()
                        .and_then(|v| i32::try_from(v).ok())
                        .ok_or_else(|| json_err("priority must be an integer"))?,
                ),
            };
            let attrs = match r.get("attrs") {
                None | Some(Value::Null) => None,
                Some(Value::Object(o)) => {
                    Some(o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                }
                Some(_) => return Err(json_err("attrs must be an object")),
            };
            let attrs_from = match r.get("getAttrs") {
                None | Some(Value::Null) => None,
                Some(Value::Object(o)) => Some(
                    o.iter()
                        .map(|(k, v)| match v {
                            Value::String(s) => Ok((k.clone(), s.clone())),
                            _ => Err(json_err("getAttrs values must be attribute names")),
                        })
                        .collect::<Result<_, _>>()?,
                ),
                Some(_) => return Err(json_err("getAttrs must be an object")),
            };
            let preserve_whitespace = match r.get("preserveWhitespace") {
                None | Some(Value::Null) => None,
                Some(Value::Bool(false)) => Some(Whitespace::Collapse),
                Some(Value::Bool(true)) => Some(Whitespace::Preserve),
                Some(Value::String(s)) if s == "full" => Some(Whitespace::Full),
                Some(_) => {
                    return Err(json_err("preserveWhitespace must be a boolean or \"full\""));
                }
            };
            Ok(ParseRule {
                tag: str_field(r, "tag")?,
                style: str_field(r, "style")?,
                priority,
                consuming: opt_bool(r, "consuming")?,
                context: str_field(r, "context")?,
                node: str_field(r, "node")?,
                mark: str_field(r, "mark")?,
                attrs,
                get_attrs: None,
                attrs_from,
                ignore: bool_field(r, "ignore", false)?,
                skip: bool_field(r, "skip", false)?,
                close_parent: bool_field(r, "closeParent", false)?,
                preserve_whitespace,
                content_element: str_field(r, "contentElement")?,
                clear_mark: None,
            })
        })
        .collect()
}

fn to_dom_from_json(spec: &Value) -> Result<Option<DomOutputSpec>, SchemaError> {
    match spec.get("toDOM") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => DomOutputSpec::from_json(v).map(Some),
    }
}

fn attrs_from_json(spec: &Value) -> Result<Vec<(String, AttrSpec)>, SchemaError> {
    entries(spec.get("attrs"))?
        .into_iter()
        .map(|(name, attr)| {
            let validate = match attr.get("validate") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(match s.as_str() {
                    "string" => AttrType::String,
                    "number" => AttrType::Number,
                    "boolean" => AttrType::Boolean,
                    "any" => AttrType::Any,
                    other => return Err(json_err(format!("Unknown attribute type {other}"))),
                }),
                Some(_) => return Err(json_err("validate must be a string")),
            };
            // `{"default": null}` is a default of null, unlike no `default`.
            let default = attr.as_object().and_then(|o| o.get("default")).cloned();
            let place = |key: &str| match attr.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(v) => Ok(Some(v)),
            };
            Ok((
                name,
                AttrSpec {
                    default,
                    validate,
                    parse_html: place("parseHTML")?.map(AttrParse::from_json).transpose()?,
                    render_html: place("renderHTML")?
                        .map(AttrRender::from_json)
                        .transpose()?,
                    keep_on_split: bool_field(attr, "keepOnSplit", true)?,
                    rendered: bool_field(attr, "rendered", true)?,
                },
            ))
        })
        .collect()
}

impl SchemaSpec {
    /// Reads a spec from ProseMirror's shape:
    /// `{"nodes": {name: {content, marks, group, inline, atom, selectable,
    /// isolating, code, defining, attrs: {name: {default, validate,
    /// parseHTML, renderHTML, keepOnSplit, rendered}}, parseDOM, toDOM,
    /// renderText}}, "marks": {name: {attrs, inclusive, excludes, group,
    /// spanning, parseDOM, toDOM, exitable, keepOnSplit, code}},
    /// "topNode": name}`. `nodes` and `marks` may also be arrays of
    /// `[name, spec]` pairs, which keep their order whatever serde_json's
    /// features (objects are read in their iteration order).
    pub fn from_json(json: &Value) -> Result<Schema, SchemaError> {
        Schema::new(Self::parse_json(json)?)
    }

    /// Reads a spec as [`SchemaSpec::from_json`] does, without building the
    /// schema.
    pub fn parse_json(json: &Value) -> Result<SchemaSpec, SchemaError> {
        let mut spec = SchemaSpec {
            top_node: str_field(json, "topNode")?,
            ..Default::default()
        };
        for (name, n) in entries(json.get("nodes"))? {
            spec.nodes.push((
                name,
                NodeSpec {
                    content: str_field(n, "content")?,
                    marks: str_field(n, "marks")?,
                    group: str_field(n, "group")?,
                    inline: bool_field(n, "inline", false)?,
                    atom: bool_field(n, "atom", false)?,
                    selectable: bool_field(n, "selectable", true)?,
                    isolating: bool_field(n, "isolating", false)?,
                    code: bool_field(n, "code", false)?,
                    defining: bool_field(n, "defining", false)?,
                    attrs: attrs_from_json(n)?,
                    leaf_text: str_field(n, "leafText")?,
                    whitespace: str_field(n, "whitespace")?,
                    defining_as_context: opt_bool(n, "definingAsContext")?,
                    defining_for_content: opt_bool(n, "definingForContent")?,
                    draggable: bool_field(n, "draggable", false)?,
                    linebreak_replacement: bool_field(n, "linebreakReplacement", false)?,
                    parse_dom: parse_dom_from_json(n)?,
                    to_dom: to_dom_from_json(n)?,
                    render_text: str_field(n, "renderText")?.map(TextRender::Template),
                    extra: extra(n, NODE_KEYS),
                },
            ));
        }
        for (name, m) in entries(json.get("marks"))? {
            spec.marks.push((
                name,
                MarkSpec {
                    attrs: attrs_from_json(m)?,
                    inclusive: bool_field(m, "inclusive", true)?,
                    excludes: str_field(m, "excludes")?,
                    group: str_field(m, "group")?,
                    spanning: bool_field(m, "spanning", true)?,
                    parse_dom: parse_dom_from_json(m)?,
                    to_dom: to_dom_from_json(m)?,
                    exitable: bool_field(m, "exitable", false)?,
                    keep_on_split: bool_field(m, "keepOnSplit", true)?,
                    // `code` stays in `extra` too, where earlier readers
                    // look for it.
                    code: bool_field(m, "code", false)?,
                    extra: extra(m, MARK_KEYS),
                },
            ));
        }
        Ok(spec)
    }
}

pub(crate) struct NodeTypeData {
    pub(crate) name: String,
    pub(crate) spec: NodeSpec,
    pub(crate) groups: Vec<String>,
    pub(crate) content: usize,
    pub(crate) inline_content: bool,
    /// `None` allows every mark.
    pub(crate) mark_set: Option<Vec<usize>>,
    pub(crate) is_text: bool,
    pub(crate) is_block: bool,
    pub(crate) has_required_attrs: bool,
}

pub(crate) struct MarkTypeData {
    pub(crate) name: String,
    pub(crate) spec: MarkSpec,
    pub(crate) excluded: Vec<usize>,
}

pub(crate) struct SchemaInner {
    pub(crate) nodes: Vec<NodeTypeData>,
    pub(crate) marks: Vec<MarkTypeData>,
    node_names: HashMap<String, usize>,
    mark_names: HashMap<String, usize>,
    top: usize,
    text: usize,
    linebreak: Option<usize>,
    pub(crate) matches: Vec<MatchState>,
    cached: Mutex<HashMap<String, Arc<dyn Any + Send + Sync>>>,
}

/// A document schema: its node and mark types. Cheap to clone (shared);
/// types, marks and nodes keep their schema alive.
#[derive(Clone)]
pub struct Schema(pub(crate) Arc<SchemaInner>);

impl PartialEq for Schema {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for Schema {}

impl fmt::Debug for Schema {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Schema")
            .field(
                "nodes",
                &self.0.nodes.iter().map(|n| &n.name).collect::<Vec<_>>(),
            )
            .field(
                "marks",
                &self.0.marks.iter().map(|m| &m.name).collect::<Vec<_>>(),
            )
            .finish()
    }
}

fn groups(group: &Option<String>) -> Vec<String> {
    group
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn gather_marks(
    names: &HashMap<String, usize>,
    marks: &[MarkTypeData],
    expr: &str,
) -> Result<Vec<usize>, SchemaError> {
    let mut found = Vec::new();
    for name in expr.split_whitespace() {
        if let Some(&i) = names.get(name) {
            found.push(i);
            continue;
        }
        let mut ok = false;
        for (i, mark) in marks.iter().enumerate() {
            if name == "_" || groups(&mark.spec.group).iter().any(|g| g == name) {
                found.push(i);
                ok = true;
            }
        }
        if !ok {
            return Err(SchemaError::Spec(format!("Unknown mark type: '{name}'")));
        }
    }
    Ok(found)
}

pub(crate) fn has_required(attrs: &[(String, AttrSpec)]) -> bool {
    attrs.iter().any(|(_, a)| a.default.is_none())
}

/// Fills the defaults of the attributes `given` lacks; extra attributes are
/// dropped, as ProseMirror's `computeAttrs` drops them.
pub(crate) fn compute_attrs(
    spec: &[(String, AttrSpec)],
    given: Option<&Attrs>,
) -> Result<Attrs, SchemaError> {
    let mut built = Attrs::new();
    for (name, attr) in spec {
        let value = match given.and_then(|g| g.get(name)) {
            Some(v) => v.clone(),
            None => match &attr.default {
                Some(d) => d.clone(),
                None => {
                    return Err(SchemaError::Attr(format!(
                        "No value supplied for attribute {name}"
                    )));
                }
            },
        };
        built.insert(name.clone(), value);
    }
    Ok(built)
}

pub(crate) fn check_attrs(
    spec: &[(String, AttrSpec)],
    attrs: &Attrs,
    kind: &str,
    type_name: &str,
) -> Result<(), SchemaError> {
    for name in attrs.keys() {
        if !spec.iter().any(|(n, _)| n == name) {
            return Err(SchemaError::Attr(format!(
                "Unsupported attribute {name} for {kind} of type {type_name}"
            )));
        }
    }
    for (name, attr) in spec {
        let Some(value) = attrs.get(name) else {
            return Err(SchemaError::Attr(format!(
                "No value supplied for attribute {name} of {kind} {type_name}"
            )));
        };
        if let Some(ty) = attr.validate {
            let null_default = value.is_null() && attr.default == Some(Value::Null);
            if !null_default && !ty.accepts(value) {
                return Err(SchemaError::Attr(format!(
                    "Invalid value for attribute {name} of {kind} {type_name}: expected {ty:?}, got {value}"
                )));
            }
        }
    }
    Ok(())
}

impl Schema {
    /// Builds a schema, compiling every content expression and checking that
    /// the spec is consistent.
    pub fn new(spec: SchemaSpec) -> Result<Schema, SchemaError> {
        let mut node_names = HashMap::new();
        let mut nodes = Vec::with_capacity(spec.nodes.len());
        for (name, nspec) in spec.nodes {
            if node_names.insert(name.clone(), nodes.len()).is_some() {
                return Err(SchemaError::Spec(format!(
                    "Node type {name} is defined twice"
                )));
            }
            let is_text = name == "text";
            nodes.push(NodeTypeData {
                groups: groups(&nspec.group),
                content: 0,
                inline_content: false,
                mark_set: None,
                is_text,
                is_block: !(nspec.inline || is_text),
                has_required_attrs: has_required(&nspec.attrs),
                name,
                spec: nspec,
            });
        }
        let mut mark_names = HashMap::new();
        let mut marks = Vec::with_capacity(spec.marks.len());
        for (name, mspec) in spec.marks {
            if node_names.contains_key(&name) {
                return Err(SchemaError::Spec(format!(
                    "{name} can not be both a node and a mark"
                )));
            }
            if mark_names.insert(name.clone(), marks.len()).is_some() {
                return Err(SchemaError::Spec(format!(
                    "Mark type {name} is defined twice"
                )));
            }
            marks.push(MarkTypeData {
                name,
                spec: mspec,
                excluded: Vec::new(),
            });
        }
        let top_name = spec.top_node.unwrap_or_else(|| "doc".into());
        let top = *node_names.get(&top_name).ok_or_else(|| {
            SchemaError::Spec(format!(
                "Schema is missing its top node type ('{top_name}')"
            ))
        })?;
        let text = *node_names
            .get("text")
            .ok_or_else(|| SchemaError::Spec("Every schema needs a 'text' type".into()))?;
        if !nodes[text].spec.attrs.is_empty() {
            return Err(SchemaError::Spec(
                "The text node type should not have attributes".into(),
            ));
        }

        let mut linebreak = None;
        for (i, node) in nodes.iter().enumerate() {
            if node.spec.linebreak_replacement {
                if linebreak.is_some() {
                    return Err(SchemaError::Spec("Multiple linebreak nodes defined".into()));
                }
                if node.is_block
                    || node
                        .spec
                        .content
                        .as_deref()
                        .is_some_and(|c| !c.trim().is_empty())
                {
                    return Err(SchemaError::Spec(
                        "Linebreak replacement nodes must be inline leaf nodes".into(),
                    ));
                }
                linebreak = Some(i);
            }
        }

        // State 0 is the empty match every leaf shares.
        let mut matches = vec![MatchState {
            valid_end: true,
            next: Vec::new(),
        }];
        let mut cache: HashMap<String, usize> = HashMap::new();
        for i in 0..nodes.len() {
            let expr = nodes[i].spec.content.clone().unwrap_or_default();
            let start = match cache.get(&expr) {
                Some(&s) => s,
                None => {
                    let s = content::compile(&expr, &nodes, &node_names, &mut matches).map_err(
                        |message| SchemaError::ContentExpr {
                            node: nodes[i].name.clone(),
                            message,
                        },
                    )?;
                    cache.insert(expr, s);
                    s
                }
            };
            nodes[i].content = start;
            nodes[i].inline_content = matches[start]
                .next
                .first()
                .is_some_and(|&(ty, _)| !nodes[ty].is_block);
        }
        for node in &mut nodes {
            node.mark_set = match node.spec.marks.as_deref() {
                Some("_") => None,
                Some(expr) if !expr.is_empty() => Some(gather_marks(&mark_names, &marks, expr)?),
                Some(_) => Some(Vec::new()),
                None if node.inline_content => None,
                None => Some(Vec::new()),
            };
        }
        for i in 0..marks.len() {
            let excluded = match marks[i].spec.excludes.as_deref() {
                None => vec![i],
                Some("") => Vec::new(),
                Some(expr) => gather_marks(&mark_names, &marks, expr)?,
            };
            marks[i].excluded = excluded;
        }
        Ok(Schema(Arc::new(SchemaInner {
            nodes,
            marks,
            node_names,
            mark_names,
            top,
            text,
            linebreak,
            matches,
            cached: Mutex::default(),
        })))
    }

    /// The node type named `name`.
    pub fn node_type(&self, name: &str) -> Option<NodeType> {
        self.0.node_names.get(name).map(|&index| NodeType {
            schema: self.clone(),
            index,
        })
    }

    /// The mark type named `name`.
    pub fn mark_type(&self, name: &str) -> Option<MarkType> {
        self.0.mark_names.get(name).map(|&index| MarkType {
            schema: self.clone(),
            index,
        })
    }

    /// The node types, in the spec's order.
    pub fn node_types(&self) -> Vec<NodeType> {
        (0..self.0.nodes.len())
            .map(|index| NodeType {
                schema: self.clone(),
                index,
            })
            .collect()
    }

    /// The mark types, in the spec's order (the order of mark sets).
    pub fn mark_types(&self) -> Vec<MarkType> {
        (0..self.0.marks.len())
            .map(|index| MarkType {
                schema: self.clone(),
                index,
            })
            .collect()
    }

    /// The type of documents.
    pub fn top_node_type(&self) -> NodeType {
        NodeType {
            schema: self.clone(),
            index: self.0.top,
        }
    }

    /// The `text` type.
    pub fn text_type(&self) -> NodeType {
        NodeType {
            schema: self.clone(),
            index: self.0.text,
        }
    }

    /// The inline leaf type standing for line breaks in code, if any.
    pub fn linebreak_replacement(&self) -> Option<NodeType> {
        self.0.linebreak.map(|index| NodeType {
            schema: self.clone(),
            index,
        })
    }

    /// A value cached on the schema under `key` (ProseMirror's
    /// `schema.cached`), computed by `init` the first time. Frameworks keep
    /// what they derive from a schema here.
    pub fn cached<T: Any + Send + Sync>(&self, key: &str, init: impl FnOnce() -> T) -> Arc<T> {
        let mut map = self.0.cached.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = map.get(key).and_then(|v| v.clone().downcast::<T>().ok()) {
            return v;
        }
        let value = Arc::new(init());
        map.insert(key.to_owned(), value.clone());
        value
    }

    /// The schema's top node type name and its node and mark specs (as
    /// given, in order).
    pub fn spec(&self) -> SchemaSpec {
        SchemaSpec {
            nodes: self
                .0
                .nodes
                .iter()
                .map(|n| (n.name.clone(), n.spec.clone()))
                .collect(),
            marks: self
                .0
                .marks
                .iter()
                .map(|m| (m.name.clone(), m.spec.clone()))
                .collect(),
            top_node: Some(self.0.nodes[self.0.top].name.clone()),
        }
    }

    /// A text node. An empty text is not a valid node: fragments drop it and
    /// `check()` rejects it.
    pub fn text(&self, text: &str, marks: Vec<Mark>) -> Node {
        Node::new_text(self.text_type(), Arc::from(text), Mark::set_from(marks))
    }

    /// A node of the type `name`, its attributes' defaults filled in and its
    /// attributes checked (its content is not: see [`Node::check`]).
    pub fn node(
        &self,
        name: &str,
        attrs: Option<Attrs>,
        content: Fragment,
        marks: Vec<Mark>,
    ) -> Result<Node, SchemaError> {
        let ty = self
            .node_type(name)
            .ok_or_else(|| SchemaError::UnknownType(name.into()))?;
        let node = ty.create(attrs, content, marks)?;
        ty.check_attrs(node.attrs())?;
        Ok(node)
    }

    /// A mark of the type `name`, its attributes' defaults filled in and
    /// checked.
    pub fn mark(&self, name: &str, attrs: Option<Attrs>) -> Result<Mark, SchemaError> {
        let ty = self
            .mark_type(name)
            .ok_or_else(|| SchemaError::UnknownType(name.into()))?;
        let mark = ty.create(attrs)?;
        ty.check_attrs(&mark.attrs)?;
        Ok(mark)
    }

    /// Reads a node from ProseMirror's JSON.
    pub fn node_from_json(&self, json: &Value) -> Result<Node, SchemaError> {
        Node::from_json(self, json)
    }

    /// Reads a mark from ProseMirror's JSON.
    pub fn mark_from_json(&self, json: &Value) -> Result<Mark, SchemaError> {
        Mark::from_json(self, json)
    }
}

/// A node type of a schema: a cheap handle (the schema and an index).
#[derive(Clone)]
pub struct NodeType {
    pub(crate) schema: Schema,
    pub(crate) index: usize,
}

impl PartialEq for NodeType {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.schema == other.schema
    }
}

impl Eq for NodeType {}

impl Hash for NodeType {
    fn hash<H: Hasher>(&self, state: &mut H) {
        (Arc::as_ptr(&self.schema.0) as usize).hash(state);
        self.index.hash(state);
    }
}

impl fmt::Debug for NodeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NodeType({})", self.name())
    }
}

impl NodeType {
    pub(crate) fn data(&self) -> &NodeTypeData {
        &self.schema.0.nodes[self.index]
    }

    /// Its name.
    pub fn name(&self) -> &str {
        &self.data().name
    }

    /// Its schema.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Its position in the schema's node types.
    pub fn index(&self) -> usize {
        self.index
    }

    /// Its definition.
    pub fn spec(&self) -> &NodeSpec {
        &self.data().spec
    }

    /// Its groups.
    pub fn groups(&self) -> &[String] {
        &self.data().groups
    }

    /// Whether it is in the group `group`.
    pub fn is_in_group(&self, group: &str) -> bool {
        self.data().groups.iter().any(|g| g == group)
    }

    /// Whether it is the text type.
    pub fn is_text(&self) -> bool {
        self.data().is_text
    }

    /// Whether it is a block type.
    pub fn is_block(&self) -> bool {
        self.data().is_block
    }

    /// Whether it is an inline type.
    pub fn is_inline(&self) -> bool {
        !self.data().is_block
    }

    /// Whether its content is inline.
    pub fn inline_content(&self) -> bool {
        self.data().inline_content
    }

    /// Whether it is a block with inline content.
    pub fn is_textblock(&self) -> bool {
        self.is_block() && self.inline_content()
    }

    /// Whether it allows no content.
    pub fn is_leaf(&self) -> bool {
        self.data().content == 0
    }

    /// Whether it is a leaf or set as an atom.
    pub fn is_atom(&self) -> bool {
        self.is_leaf() || self.spec().atom
    }

    /// Whether its content is code.
    pub fn is_code(&self) -> bool {
        self.spec().code
    }

    /// Whether the node is kept when its content is replaced.
    pub fn is_defining_as_context(&self) -> bool {
        self.spec()
            .defining_as_context
            .unwrap_or(self.spec().defining)
    }

    /// Whether its type is kept when its content is pasted elsewhere.
    pub fn is_defining_for_content(&self) -> bool {
        self.spec()
            .defining_for_content
            .unwrap_or(self.spec().defining)
    }

    /// Whether it is defining in either sense.
    pub fn is_defining(&self) -> bool {
        self.is_defining_as_context() || self.is_defining_for_content()
    }

    /// How whitespace in its content is treated: `"pre"` or `"normal"`.
    pub fn whitespace(&self) -> &str {
        self.spec()
            .whitespace
            .as_deref()
            .unwrap_or(if self.spec().code { "pre" } else { "normal" })
    }

    /// Whether some attribute has no default.
    pub fn has_required_attrs(&self) -> bool {
        self.data().has_required_attrs
    }

    /// The start of its content expression's automaton.
    pub fn content_match(&self) -> ContentMatch {
        ContentMatch {
            schema: self.schema.clone(),
            state: self.data().content,
        }
    }

    /// Its attributes with their defaults, or none when one is required.
    pub fn default_attrs(&self) -> Option<Attrs> {
        compute_attrs(&self.spec().attrs, None).ok()
    }

    /// `attrs` with the defaults of the attributes it lacks.
    pub fn compute_attrs(&self, attrs: Option<&Attrs>) -> Result<Attrs, SchemaError> {
        compute_attrs(&self.spec().attrs, attrs)
    }

    /// Checks attributes against its specs: no unknown ones, none missing,
    /// each of its type.
    pub fn check_attrs(&self, attrs: &Attrs) -> Result<(), SchemaError> {
        check_attrs(&self.spec().attrs, attrs, "node", self.name())
    }

    /// The attributes the second half of a node of this type with `attrs`
    /// gets when it is split (Tiptap's `getSplittedAttributes`): those
    /// with `keep_on_split`, the others back at their defaults.
    pub fn split_attrs(&self, attrs: &Attrs) -> Attrs {
        let kept: Attrs = self
            .spec()
            .attrs
            .iter()
            .filter(|(_, spec)| spec.keep_on_split)
            .filter_map(|(name, _)| Some((name.clone(), attrs.get(name)?.clone())))
            .collect();
        self.compute_attrs(Some(&kept))
            .unwrap_or_else(|_| attrs.clone())
    }

    /// Whether `content` is valid content for it, its marks included.
    pub fn valid_content(&self, content: &Fragment) -> bool {
        match self
            .content_match()
            .match_fragment(content, 0, content.child_count())
        {
            Some(m) if m.valid_end() => content.iter().all(|c| self.allows_marks(c.marks())),
            _ => false,
        }
    }

    /// Fails when `content` is not valid content for it.
    pub fn check_content(&self, content: &Fragment) -> Result<(), SchemaError> {
        if self.valid_content(content) {
            Ok(())
        } else {
            let shown: Vec<String> = content.iter().map(|c| c.to_string()).collect();
            Err(SchemaError::InvalidContent(format!(
                "Invalid content for node {}: <{}>",
                self.name(),
                shown.join(", ")
            )))
        }
    }

    /// Whether marks of `mark` are allowed in its content.
    pub fn allows_mark_type(&self, mark: &MarkType) -> bool {
        match &self.data().mark_set {
            None => true,
            Some(set) => set.contains(&mark.index),
        }
    }

    /// Whether all of `marks` are allowed in its content.
    pub fn allows_marks(&self, marks: &[Mark]) -> bool {
        marks.iter().all(|m| self.allows_mark_type(&m.ty))
    }

    /// The marks of `marks` allowed in its content.
    pub fn allowed_marks(&self, marks: &[Mark]) -> Vec<Mark> {
        marks
            .iter()
            .filter(|m| self.allows_mark_type(&m.ty))
            .cloned()
            .collect()
    }

    /// Whether its content and `other`'s may join (some type both accept
    /// first).
    pub fn compatible_content(&self, other: &NodeType) -> bool {
        self == other || self.content_match().compatible(&other.content_match())
    }

    /// A node of this type with the defaults of missing attributes. Neither
    /// its content nor its attributes are checked (see [`Node::check`]).
    pub fn create(
        &self,
        attrs: Option<Attrs>,
        content: Fragment,
        marks: Vec<Mark>,
    ) -> Result<Node, SchemaError> {
        if self.is_text() {
            return Err(SchemaError::Spec(
                "NodeType::create can't construct text nodes".into(),
            ));
        }
        let attrs = self.compute_attrs(attrs.as_ref())?;
        Ok(Node::new(
            self.clone(),
            attrs,
            content,
            Mark::set_from(marks),
        ))
    }

    /// As [`NodeType::create`], also checking the content and attributes.
    pub fn create_checked(
        &self,
        attrs: Option<Attrs>,
        content: Fragment,
        marks: Vec<Mark>,
    ) -> Result<Node, SchemaError> {
        self.check_content(&content)?;
        let node = self.create(attrs, content, marks)?;
        self.check_attrs(node.attrs())?;
        Ok(node)
    }

    /// A node of this type whose content is `content` with what its content
    /// expression requires before and after it filled in; none when that is
    /// impossible (or an attribute is missing).
    pub fn create_and_fill(
        &self,
        attrs: Option<Attrs>,
        content: Fragment,
        marks: Vec<Mark>,
    ) -> Option<Node> {
        if self.is_text() {
            return None;
        }
        let attrs = self.compute_attrs(attrs.as_ref()).ok()?;
        let mut content = content;
        if content.size() > 0 {
            let before = self.content_match().fill_before(&content, false, 0)?;
            content = before.append(&content);
        }
        let matched = self
            .content_match()
            .match_fragment(&content, 0, content.child_count())?;
        let after = matched.fill_before(&Fragment::empty(), true, 0)?;
        Some(Node::new(
            self.clone(),
            attrs,
            content.append(&after),
            Mark::set_from(marks),
        ))
    }
}

/// A mark type of a schema: a cheap handle (the schema and an index, its
/// rank in mark sets).
#[derive(Clone)]
pub struct MarkType {
    pub(crate) schema: Schema,
    pub(crate) index: usize,
}

impl PartialEq for MarkType {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.schema == other.schema
    }
}

impl Eq for MarkType {}

impl Hash for MarkType {
    fn hash<H: Hasher>(&self, state: &mut H) {
        (Arc::as_ptr(&self.schema.0) as usize).hash(state);
        self.index.hash(state);
    }
}

impl fmt::Debug for MarkType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MarkType({})", self.name())
    }
}

impl MarkType {
    fn data(&self) -> &MarkTypeData {
        &self.schema.0.marks[self.index]
    }

    /// Its name.
    pub fn name(&self) -> &str {
        &self.data().name
    }

    /// Its schema.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Its rank: the order of mark sets.
    pub fn rank(&self) -> usize {
        self.index
    }

    /// Its definition.
    pub fn spec(&self) -> &MarkSpec {
        &self.data().spec
    }

    /// Whether text typed at its end gets it.
    pub fn is_inclusive(&self) -> bool {
        self.spec().inclusive
    }

    /// A mark of this type with the defaults of missing attributes.
    pub fn create(&self, attrs: Option<Attrs>) -> Result<Mark, SchemaError> {
        let attrs = compute_attrs(&self.spec().attrs, attrs.as_ref())?;
        Ok(Mark {
            ty: self.clone(),
            attrs,
        })
    }

    /// Checks attributes against its specs.
    pub fn check_attrs(&self, attrs: &Attrs) -> Result<(), SchemaError> {
        check_attrs(&self.spec().attrs, attrs, "mark", self.name())
    }

    /// Whether it excludes `other` (marks of the two cannot share a set).
    pub fn excludes(&self, other: &MarkType) -> bool {
        self.schema == other.schema && self.data().excluded.contains(&other.index)
    }

    /// The mark of this type in `set`.
    pub fn is_in_set<'a>(&self, set: &'a [Mark]) -> Option<&'a Mark> {
        set.iter().find(|m| &m.ty == self)
    }

    /// `set` without marks of this type.
    pub fn remove_from_set(&self, set: &[Mark]) -> Vec<Mark> {
        set.iter().filter(|m| &m.ty != self).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::model::test_schema::schema;

    #[test]
    fn types_and_flags() {
        let s = schema();
        let p = s.node_type("paragraph").unwrap();
        assert!(p.is_block() && p.is_textblock() && !p.is_leaf());
        let img = s.node_type("image").unwrap();
        assert!(img.is_inline() && img.is_leaf() && img.is_atom() && img.has_required_attrs());
        assert!(s.text_type().is_text() && s.text_type().is_inline());
        assert_eq!(s.top_node_type().name(), "doc");
        let cb = s.node_type("code_block").unwrap();
        assert!(!cb.allows_mark_type(&s.mark_type("em").unwrap()));
        assert!(p.allows_mark_type(&s.mark_type("em").unwrap()));
        assert!(
            !s.node_type("doc")
                .unwrap()
                .allows_mark_type(&s.mark_type("em").unwrap())
        );
        assert_eq!(p, s.node_type("paragraph").unwrap());
        assert_ne!(
            p,
            schema().node_type("paragraph").unwrap(),
            "types of another schema"
        );
    }

    #[test]
    fn rejects_bad_specs() {
        let bad = |v| SchemaSpec::from_json(&v).unwrap_err();
        assert!(matches!(
            bad(json!({"nodes": [["doc", {"content": "text*"}]]})),
            SchemaError::Spec(_)
        ));
        assert!(matches!(
            bad(json!({"nodes": [["text", {}]]})),
            SchemaError::Spec(_)
        ));
        assert!(matches!(
            bad(json!({"nodes": [["doc", {"content": "nope+"}], ["text", {}]]})),
            SchemaError::ContentExpr { .. }
        ));
        assert!(matches!(
            bad(json!({"nodes": [["doc", {"content": "text*"}], ["text", {"attrs": {"a": {}}}]]})),
            SchemaError::Spec(_)
        ));
        assert!(matches!(
            bad(
                json!({"nodes": [["doc", {"content": "text*"}], ["text", {}]], "marks": [["doc", {}]]})
            ),
            SchemaError::Spec(_)
        ));
        assert!(matches!(
            bad(json!({"nodes": [["doc", {"content": "text*", "marks": "zz"}], ["text", {}]]})),
            SchemaError::Spec(_)
        ));
        // A required non-generatable node in a required position is a dead end.
        assert!(matches!(
            bad(
                json!({"nodes": [["doc", {"content": "img"}], ["img", {"attrs": {"src": {}}}], ["text", {}]]})
            ),
            SchemaError::ContentExpr { .. }
        ));
    }

    #[test]
    fn attrs_defaults_and_validation() {
        let s = schema();
        let h = s.node("heading", None, Fragment::empty(), vec![]).unwrap();
        assert_eq!(h.attrs()["level"], json!(1));
        let mut bad = Attrs::new();
        bad.insert("level".into(), json!("x"));
        assert!(matches!(
            s.node("heading", Some(bad), Fragment::empty(), vec![]),
            Err(SchemaError::Attr(_))
        ));
        assert!(
            s.node("image", None, Fragment::empty(), vec![]).is_err(),
            "src is required"
        );
        assert!(s.mark("link", None).is_err());
        let mut href = Attrs::new();
        href.insert("href".into(), json!("x"));
        assert!(s.mark("link", Some(href)).is_ok());
        let img = s.node_type("image").unwrap();
        let mut a = Attrs::new();
        a.insert("src".into(), json!("a.png"));
        a.insert("alt".into(), Value::Null);
        assert!(
            img.check_attrs(&a).is_ok(),
            "null passes when it is the default"
        );
        a.insert("extra".into(), json!(1));
        assert!(img.check_attrs(&a).is_err());
    }

    #[test]
    fn mark_excludes() {
        let s = SchemaSpec::from_json(&json!({
            "nodes": [["doc", {"content": "text*"}], ["text", {}]],
            "marks": [["a", {"group": "g"}], ["b", {"excludes": "g"}], ["c", {"excludes": ""}], ["d", {"excludes": "_"}]]
        }))
        .unwrap();
        let m = |n| s.mark_type(n).unwrap();
        assert!(m("a").excludes(&m("a")));
        assert!(m("b").excludes(&m("a")) && !m("b").excludes(&m("b")));
        assert!(!m("c").excludes(&m("c")));
        assert!(m("d").excludes(&m("a")) && m("d").excludes(&m("d")));
    }

    #[test]
    fn extras_and_cache() {
        let s = SchemaSpec::from_json(&json!({
            "nodes": [["doc", {"content": "text*", "x-ui": {"icon": "doc"}}],
                      ["text", {}], ["br", {"inline": true, "linebreakReplacement": true, "leafText": "\n"}]],
            "marks": [["m", {"keepOnSplit": true}]]
        }))
        .unwrap();
        assert_eq!(
            s.top_node_type().spec().extra["x-ui"],
            json!({"icon": "doc"})
        );
        assert!(s.mark_type("m").unwrap().spec().keep_on_split);
        let tiptap = SchemaSpec::from_json(&json!({
            "nodes": [["doc", {"content": "p+"}], ["p", {"content": "text*",
                "attrs": {"id": {"default": null, "keepOnSplit": false}, "align": {"default": "left"}},
                "toDOM": ["p", 0], "renderText": "x"}], ["text", {}]],
            "marks": [["c", {"code": true, "exitable": true, "keepOnSplit": false, "toDOM": ["code", 0]}]]
        }))
        .unwrap();
        let c = tiptap.mark_type("c").unwrap();
        assert!(c.spec().code && c.spec().exitable && !c.spec().keep_on_split);
        // `code` stays in `extra` for the readers that look there.
        assert_eq!(c.spec().extra["code"], json!(true));
        assert!(c.spec().to_dom.is_some());
        let p = tiptap.node_type("p").unwrap();
        assert!(p.spec().render_text.is_some() && p.spec().to_dom.is_some());
        let mut attrs = Attrs::new();
        attrs.insert("id".into(), json!("a"));
        attrs.insert("align".into(), json!("right"));
        let split = p.split_attrs(&attrs);
        assert_eq!(split["id"], Value::Null);
        assert_eq!(split["align"], json!("right"));
        let m = tiptap.mark("c", None).unwrap();
        assert!(crate::rich_editor::model::marks_kept_on_split(&[m]).is_empty());
        assert_eq!(s.linebreak_replacement().unwrap().name(), "br");
        assert_eq!(
            s.node_type("br").unwrap().spec().leaf_text.as_deref(),
            Some("\n")
        );
        let a = s.cached("k", || 5usize);
        let b = s.cached("k", || 6usize);
        assert_eq!((*a, *b), (5, 5));
    }

    #[test]
    fn create_and_fill() {
        let s = schema();
        let d = s
            .top_node_type()
            .create_and_fill(None, Fragment::empty(), vec![])
            .unwrap();
        assert_eq!(d.to_string(), "doc(paragraph)");
        let li = s.node_type("list_item").unwrap();
        assert_eq!(
            li.create_and_fill(None, Fragment::empty(), vec![])
                .unwrap()
                .to_string(),
            "list_item(paragraph)"
        );
        assert!(
            s.node_type("image")
                .unwrap()
                .create_and_fill(None, Fragment::empty(), vec![])
                .is_none()
        );
    }
}
