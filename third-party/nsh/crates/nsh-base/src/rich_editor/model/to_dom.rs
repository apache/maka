//! How nodes and marks render as HTML (`prosemirror-model`'s
//! `DOMOutputSpec`, Tiptap's `renderHTML` / `renderText` and its attributes'
//! `parseHTML` / `renderHTML`), as data with a Rust callback form.
//!
//! The data form is ProseMirror's array: `["h1", {"class": "x"}, 0]` is an
//! `<h1 class="x">` holding the content, nested arrays are child elements,
//! strings texts and `0` the hole content goes in. An attribute value
//! `{"attr": "href"}` reads the node's or mark's attribute `href` (a null
//! one leaves the DOM attribute out), and so does a child `{"attr": ...}`,
//! as text. [`DomSerializer`](crate::rich_editor::formats::DomSerializer)
//! writes documents with them.

use std::{fmt, sync::Arc};

use serde_json::Value;

use super::{Attrs, Mark, Node, SchemaError};

/// What a [`DomRender`] callback renders.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub enum DomSource<'a> {
    /// A node.
    Node(&'a Node),
    /// A mark, with whether it wraps inline content (always, for marks in
    /// textblocks).
    Mark {
        /// The mark.
        mark: &'a Mark,
        /// Whether its content is inline.
        inline: bool,
    },
}

impl<'a> DomSource<'a> {
    /// The attributes of the node or mark.
    pub fn attrs(&self) -> &'a Attrs {
        match self {
            Self::Node(node) => node.attrs(),
            Self::Mark { mark, .. } => mark.attrs(),
        }
    }

    /// The attribute `name`, none when absent or null.
    pub fn attr(&self, name: &str) -> Option<&'a Value> {
        self.attrs().get(name).filter(|v| !v.is_null())
    }
}

type DomRenderFn = dyn Fn(DomSource<'_>) -> DomOutputSpec + Send + Sync;

/// The callback form of a [`DomOutputSpec`] (ProseMirror's `toDOM`
/// function): the spec of one node or mark. Equal when it is the same
/// callback.
#[derive(Clone)]
pub struct DomRender(pub Arc<DomRenderFn>);

impl DomRender {
    /// A callback of `f`.
    pub fn new(f: impl Fn(DomSource<'_>) -> DomOutputSpec + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }
}

impl PartialEq for DomRender {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for DomRender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DomRender(..)")
    }
}

/// The value of a DOM attribute in a [`DomOutputSpec`].
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum DomAttrValue {
    /// A fixed value; null leaves the attribute out, numbers and booleans
    /// are written as text.
    Value(Value),
    /// The node's or mark's attribute of this name (`{"attr": "href"}`).
    Attr(String),
}

/// The DOM structure a node or mark renders as (ProseMirror's
/// `DOMOutputSpec`).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum DomOutputSpec {
    /// A text.
    Text(String),
    /// The text of the node's or mark's attribute of this name.
    AttrText(String),
    /// Where the content goes (`0`): the only child of its element.
    Hole,
    /// An element.
    Element {
        /// The tag name.
        tag: String,
        /// The DOM attributes, in order.
        attrs: Vec<(String, DomAttrValue)>,
        /// The children.
        children: Vec<DomOutputSpec>,
    },
    /// A callback computing the spec for each node or mark.
    Render(DomRender),
}

impl DomOutputSpec {
    /// An element of `tag` without attributes or children.
    pub fn tag(tag: impl Into<String>) -> Self {
        Self::Element {
            tag: tag.into(),
            attrs: Vec::new(),
            children: Vec::new(),
        }
    }

    /// The callback form.
    pub fn render(f: impl Fn(DomSource<'_>) -> DomOutputSpec + Send + Sync + 'static) -> Self {
        Self::Render(DomRender::new(f))
    }

    /// The element with the fixed attribute `name` = `value` (null leaves
    /// it out). No effect on other forms.
    pub fn attr(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        if let Self::Element { attrs, .. } = &mut self {
            attrs.push((name.into(), DomAttrValue::Value(value.into())));
        }
        self
    }

    /// The element with the attribute `name` read from the node's or
    /// mark's attribute `from`.
    pub fn attr_of(mut self, name: impl Into<String>, from: impl Into<String>) -> Self {
        if let Self::Element { attrs, .. } = &mut self {
            attrs.push((name.into(), DomAttrValue::Attr(from.into())));
        }
        self
    }

    /// The element with `child` appended.
    pub fn child(mut self, child: DomOutputSpec) -> Self {
        if let Self::Element { children, .. } = &mut self {
            children.push(child);
        }
        self
    }

    /// The element holding the content (`["tag", 0]`).
    pub fn hole(self) -> Self {
        self.child(Self::Hole)
    }

    /// Reads ProseMirror's array form: a string is a text, `0` the hole,
    /// `{"attr": name}` an attribute's text, an array `[tag, attrs?,
    /// ...children]` an element whose attribute values are strings,
    /// numbers, booleans, null or `{"attr": name}`.
    pub fn from_json(json: &Value) -> Result<Self, SchemaError> {
        let err = |m: &str| SchemaError::Json(format!("toDOM: {m}"));
        match json {
            Value::String(s) => Ok(Self::Text(s.clone())),
            Value::Number(n) if n.as_u64() == Some(0) => Ok(Self::Hole),
            Value::Object(o) => match o.get("attr") {
                Some(Value::String(name)) if o.len() == 1 => Ok(Self::AttrText(name.clone())),
                _ => Err(err("objects must be {\"attr\": name}")),
            },
            Value::Array(items) => {
                let Some(Value::String(tag)) = items.first() else {
                    return Err(err("an element starts with its tag name"));
                };
                let mut rest = &items[1..];
                let mut attrs = Vec::new();
                if let Some(Value::Object(map)) = rest.first() {
                    rest = &rest[1..];
                    for (name, value) in map {
                        let value = match value {
                            Value::Object(o) => match o.get("attr") {
                                Some(Value::String(from)) if o.len() == 1 => {
                                    DomAttrValue::Attr(from.clone())
                                }
                                _ => {
                                    return Err(err(
                                        "attribute values are scalars or {\"attr\": name}",
                                    ));
                                }
                            },
                            Value::Array(_) => {
                                return Err(err(
                                    "attribute values are scalars or {\"attr\": name}",
                                ));
                            }
                            v => DomAttrValue::Value(v.clone()),
                        };
                        attrs.push((name.clone(), value));
                    }
                }
                let children = rest.iter().map(Self::from_json).collect::<Result<_, _>>()?;
                Ok(Self::Element {
                    tag: tag.clone(),
                    attrs,
                    children,
                })
            }
            _ => Err(err("expected a string, 0, an array or {\"attr\": name}")),
        }
    }

    /// The data form as JSON (a callback is `null`).
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(s) => Value::from(s.as_str()),
            Self::AttrText(name) => serde_json::json!({ "attr": name }),
            Self::Hole => Value::from(0),
            Self::Render(_) => Value::Null,
            Self::Element {
                tag,
                attrs,
                children,
            } => {
                let mut out = vec![Value::from(tag.as_str())];
                if !attrs.is_empty() {
                    out.push(Value::Object(
                        attrs
                            .iter()
                            .map(|(k, v)| {
                                let v = match v {
                                    DomAttrValue::Value(v) => v.clone(),
                                    DomAttrValue::Attr(a) => serde_json::json!({ "attr": a }),
                                };
                                (k.clone(), v)
                            })
                            .collect(),
                    ));
                }
                out.extend(children.iter().map(Self::to_json));
                Value::Array(out)
            }
        }
    }
}

/// Where an attribute's value is read from in HTML (Tiptap's attribute
/// `parseHTML`), for the tag rules of its type; an attribute without one
/// reads the DOM attribute of its own name. Values read as `"true"`,
/// `"false"` or numbers become booleans and numbers (Tiptap's
/// `fromString`).
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum AttrParse {
    /// A DOM attribute (`"data-color"`).
    Attribute(String),
    /// A style property (`"color"`).
    Style(String),
    /// Not read from HTML (JSON `false`).
    Skip,
}

impl AttrParse {
    /// Reads `{"attribute": name}`, `{"style": property}`, a string (an
    /// attribute name) or `false` ([`AttrParse::Skip`]).
    pub fn from_json(json: &Value) -> Result<Self, SchemaError> {
        if json == &Value::Bool(false) {
            return Ok(Self::Skip);
        }
        parse_attr_place(json, "parseHTML").map(|(attr, name)| match attr {
            true => Self::Attribute(name),
            false => Self::Style(name),
        })
    }
}

/// Where an attribute's value is written in HTML (Tiptap's attribute
/// `renderHTML`), merged into the outer element of its type's rendering;
/// an attribute without one writes the DOM attribute of its own name, and
/// a null value writes nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum AttrRender {
    /// A DOM attribute (`"data-color"`).
    Attribute(String),
    /// A style property (`"color"`), added to `style`.
    Style(String),
    /// Not written (JSON `false`); the type's `to_dom` may still write
    /// it.
    Skip,
}

impl AttrRender {
    /// Reads `{"attribute": name}`, `{"style": property}`, a string (an
    /// attribute name) or `false` ([`AttrRender::Skip`]).
    pub fn from_json(json: &Value) -> Result<Self, SchemaError> {
        if json == &Value::Bool(false) {
            return Ok(Self::Skip);
        }
        parse_attr_place(json, "renderHTML").map(|(attr, name)| match attr {
            true => Self::Attribute(name),
            false => Self::Style(name),
        })
    }
}

fn parse_attr_place(json: &Value, key: &str) -> Result<(bool, String), SchemaError> {
    match json {
        Value::String(s) => Ok((true, s.clone())),
        Value::Object(o) => match (o.get("attribute"), o.get("style")) {
            (Some(Value::String(s)), None) => Ok((true, s.clone())),
            (None, Some(Value::String(s))) => Ok((false, s.clone())),
            _ => Err(SchemaError::Json(format!(
                "{key} must be {{\"attribute\": name}} or {{\"style\": property}}"
            ))),
        },
        _ => Err(SchemaError::Json(format!(
            "{key} must be a string or an object"
        ))),
    }
}

type TextRenderFn = dyn Fn(&Node) -> String + Send + Sync;

/// The text a node counts as in plain text (Tiptap's `renderText`).
#[derive(Clone)]
#[non_exhaustive]
pub enum TextRender {
    /// A template: `{name}` is replaced by the node's attribute `name`
    /// (empty when null), `{{` and `}}` are braces.
    Template(String),
    /// A callback.
    Render(Arc<TextRenderFn>),
}

impl TextRender {
    /// The callback form.
    pub fn new(f: impl Fn(&Node) -> String + Send + Sync + 'static) -> Self {
        Self::Render(Arc::new(f))
    }

    /// The text of `node`.
    pub fn text(&self, node: &Node) -> String {
        match self {
            Self::Render(f) => f(node),
            Self::Template(t) => {
                let mut out = String::new();
                let mut rest = t.as_str();
                while let Some(i) = rest.find(['{', '}']) {
                    out.push_str(&rest[..i]);
                    let tail = &rest[i..];
                    if tail.starts_with("{{") || tail.starts_with("}}") {
                        out.push_str(&tail[..1]);
                        rest = &tail[2..];
                    } else if let (true, Some(end)) = (tail.starts_with('{'), tail.find('}')) {
                        out.push_str(&attr_text(node.attrs().get(&tail[1..end])));
                        rest = &tail[end + 1..];
                    } else {
                        out.push_str(&tail[..1]);
                        rest = &tail[1..];
                    }
                }
                out.push_str(rest);
                out
            }
        }
    }
}

impl PartialEq for TextRender {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Template(a), Self::Template(b)) => a == b,
            (Self::Render(a), Self::Render(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl fmt::Debug for TextRender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Template(t) => f.debug_tuple("Template").field(t).finish(),
            Self::Render(_) => f.write_str("Render(..)"),
        }
    }
}

/// An attribute value as DOM text: none for null, strings as they are,
/// other values as JSON.
pub fn attr_value_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        v => Some(v.to_string()),
    }
}

fn attr_text(value: Option<&Value>) -> String {
    value.and_then(attr_value_text).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_form_round_trips() {
        let v =
            json!(["a", {"href": {"attr": "href"}, "rel": "x"}, ["b", 0], "t", {"attr": "title"}]);
        let spec = DomOutputSpec::from_json(&v).unwrap();
        assert_eq!(spec.to_json(), v);
        assert!(DomOutputSpec::from_json(&json!([1])).is_err());
        assert!(DomOutputSpec::from_json(&json!(["a", {"x": [1]}])).is_err());
    }

    #[test]
    fn attr_places() {
        assert_eq!(
            AttrRender::from_json(&json!({"style": "color"})).unwrap(),
            AttrRender::Style("color".into())
        );
        assert_eq!(
            AttrParse::from_json(&json!("data-x")).unwrap(),
            AttrParse::Attribute("data-x".into())
        );
        assert!(AttrParse::from_json(&json!(1)).is_err());
    }
}
