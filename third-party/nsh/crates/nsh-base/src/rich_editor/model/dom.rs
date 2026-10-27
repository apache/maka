//! Parse rules (`prosemirror-model`'s `ParseRule`, `TagParseRule` and
//! `StyleParseRule`) and the read-only DOM they match against.
//!
//! Node and mark specs carry their rules in `parse_dom`;
//! [`DomParser`](crate::rich_editor::formats::DomParser) reads HTML with
//! them. The DOM is an owned tree built from html5ever's, so rules and
//! their callbacks never hold the parser's reference-counted nodes.

use std::{collections::BTreeMap, fmt, sync::Arc};

use super::{Attrs, Mark};

/// A node of a parsed HTML tree.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DomNode {
    /// An element.
    Element(DomElement),
    /// A run of text, entities decoded.
    Text(String),
    /// A comment (`<!--StartFragment-->`), which parsing skips.
    Comment,
}

impl DomNode {
    /// The element, when this is one.
    pub fn as_element(&self) -> Option<&DomElement> {
        match self {
            Self::Element(el) => Some(el),
            _ => None,
        }
    }
}

/// An element of a parsed HTML tree: its tag name, attributes and
/// children, read-only for parse rules' callbacks.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct DomElement {
    pub(crate) tag: String,
    pub(crate) attrs: Vec<(String, String)>,
    pub(crate) children: Vec<DomNode>,
}

impl DomElement {
    /// An element of `tag` (lower case) with `attrs` and `children`.
    pub fn new(
        tag: impl Into<String>,
        attrs: Vec<(String, String)>,
        children: Vec<DomNode>,
    ) -> Self {
        Self {
            tag: tag.into().to_ascii_lowercase(),
            attrs,
            children,
        }
    }

    /// The tag name, in lower case (`"p"`, `"h1"`).
    pub fn tag_name(&self) -> &str {
        &self.tag
    }

    /// The value of attribute `name`, none when it is absent.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Whether attribute `name` is present.
    pub fn has_attr(&self, name: &str) -> bool {
        self.attr(name).is_some()
    }

    /// The attributes in document order.
    pub fn attrs(&self) -> &[(String, String)] {
        &self.attrs
    }

    /// Whether the `class` attribute lists `class`.
    pub fn has_class(&self, class: &str) -> bool {
        self.attr("class")
            .is_some_and(|c| c.split_ascii_whitespace().any(|c| c == class))
    }

    /// The declarations of the `style` attribute, property names in lower
    /// case, the last of a property winning (as `element.style` reads them).
    pub fn styles(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        if let Some(style) = self.attr("style") {
            for decl in style.split(';') {
                let Some((key, value)) = decl.split_once(':') else {
                    continue;
                };
                let value = value.trim();
                let value = value
                    .strip_suffix("!important")
                    .map_or(value, str::trim_end)
                    .to_owned();
                let key = key.trim().to_ascii_lowercase();
                if !key.is_empty() && !value.is_empty() {
                    out.insert(key, value);
                }
            }
        }
        out
    }

    /// The value of style property `property` in the `style` attribute.
    pub fn style(&self, property: &str) -> Option<String> {
        self.styles().remove(&property.to_ascii_lowercase())
    }

    /// The child nodes.
    pub fn children(&self) -> &[DomNode] {
        &self.children
    }

    /// The text of the element and its descendants.
    pub fn text_content(&self) -> String {
        fn walk(el: &DomElement, out: &mut String) {
            for child in &el.children {
                match child {
                    DomNode::Text(t) => out.push_str(t),
                    DomNode::Element(e) => walk(e, out),
                    DomNode::Comment => {}
                }
            }
        }
        let mut out = String::new();
        walk(self, &mut out);
        out
    }

    /// Whether the element matches `selector`: a comma-separated list of
    /// compound selectors made of a tag name (or `*`), `.class`, `#id`,
    /// `[attr]` and `[attr=value]` (the value optionally quoted).
    pub fn matches(&self, selector: &str) -> bool {
        selector
            .split(',')
            .any(|s| matches_compound(self, s.trim()))
    }

    /// The first descendant matching `selector` (`querySelector`).
    pub fn query_selector(&self, selector: &str) -> Option<&DomElement> {
        for child in &self.children {
            if let DomNode::Element(el) = child {
                if el.matches(selector) {
                    return Some(el);
                }
                if let Some(found) = el.query_selector(selector) {
                    return Some(found);
                }
            }
        }
        None
    }
}

fn matches_compound(el: &DomElement, sel: &str) -> bool {
    if sel.is_empty() {
        return false;
    }
    let bytes = sel.as_bytes();
    let ident_end = |from: usize| {
        let mut j = from;
        while j < bytes.len() && !matches!(bytes[j], b'.' | b'#' | b'[') {
            j += 1;
        }
        j
    };
    // The tag name.
    let end = ident_end(0);
    let tag = &sel[..end];
    if !tag.is_empty() && tag != "*" && !tag.eq_ignore_ascii_case(&el.tag) {
        return false;
    }
    let mut i = end;
    while i < bytes.len() {
        match bytes[i] {
            b'.' => {
                let end = ident_end(i + 1);
                if !el.has_class(&sel[i + 1..end]) {
                    return false;
                }
                i = end;
            }
            b'#' => {
                let end = ident_end(i + 1);
                if el.attr("id") != Some(&sel[i + 1..end]) {
                    return false;
                }
                i = end;
            }
            b'[' => {
                let Some(close) = sel[i..].find(']') else {
                    return false;
                };
                let inner = &sel[i + 1..i + close];
                let ok = match inner.split_once('=') {
                    Some((name, value)) => {
                        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
                        el.attr(name.trim()) == Some(value)
                    }
                    None => el.has_attr(inner.trim()),
                };
                if !ok {
                    return false;
                }
                i += close + 1;
            }
            _ => return false,
        }
    }
    true
}

/// How a rule's content treats whitespace (ProseMirror's
/// `preserveWhitespace`: `false`, `true` or `"full"`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Whitespace {
    /// Runs of whitespace collapse to one space (`false`).
    #[default]
    Collapse,
    /// Whitespace is kept, newlines becoming spaces or line breaks
    /// (`true`).
    Preserve,
    /// Whitespace and newlines are kept as they are (`"full"`).
    Full,
}

/// What a rule's [`GetAttrs`] callback is given.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub enum RuleInput<'a> {
    /// A tag rule's matched element.
    Element(&'a DomElement),
    /// A style rule's property value (`"bold"`, `"700"`).
    Style(&'a str),
}

impl<'a> RuleInput<'a> {
    /// The element, for a tag rule.
    pub fn element(&self) -> Option<&'a DomElement> {
        match self {
            Self::Element(el) => Some(el),
            Self::Style(_) => None,
        }
    }

    /// The style value, for a style rule.
    pub fn style_value(&self) -> Option<&'a str> {
        match self {
            Self::Style(v) => Some(v),
            Self::Element(_) => None,
        }
    }
}

type GetAttrsFn = dyn Fn(RuleInput<'_>) -> Option<Attrs> + Send + Sync;

/// A rule's attribute callback (ProseMirror's `getAttrs`): the attributes
/// of what it creates, `None` when the rule does not match after all.
/// Equal when it is the same callback.
#[derive(Clone)]
pub struct GetAttrs(pub Arc<GetAttrsFn>);

impl GetAttrs {
    /// A callback of `f`.
    pub fn new(f: impl Fn(RuleInput<'_>) -> Option<Attrs> + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }
}

impl PartialEq for GetAttrs {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for GetAttrs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GetAttrs(..)")
    }
}

type ClearMarkFn = dyn Fn(&Mark) -> bool + Send + Sync;

/// A style rule's mark filter (ProseMirror's `clearMark`): the active marks
/// it returns `true` for are removed. Equal when it is the same callback.
#[derive(Clone)]
pub struct ClearMark(pub Arc<ClearMarkFn>);

impl ClearMark {
    /// A filter of `f`.
    pub fn new(f: impl Fn(&Mark) -> bool + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    /// A filter clearing the marks of type `name`.
    pub fn named(name: impl Into<String>) -> Self {
        let name = name.into();
        Self::new(move |m| m.ty().name() == name)
    }
}

impl PartialEq for ClearMark {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for ClearMark {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClearMark(..)")
    }
}

/// How an HTML element or style becomes a node or mark (ProseMirror's
/// `ParseRule`): a tag rule sets [`tag`](Self::tag), a style rule
/// [`style`](Self::style). In a node or mark spec's `parse_dom`, the rule
/// creates that type unless it names another.
#[derive(Clone, Debug, Default, PartialEq)]
#[non_exhaustive]
pub struct ParseRule {
    /// The selector elements must match (`"p"`, `"a[href]"`,
    /// `"span.mention"`, `"h1, h2"`).
    pub tag: Option<String>,
    /// The style property, optionally with the value it must have
    /// (`"font-weight"`, `"font-style=italic"`).
    pub style: Option<String>,
    /// Rules are tried by descending priority (50 when unset), then in
    /// schema order.
    pub priority: Option<i32>,
    /// Whether a match ends the search (default); `Some(false)` lets later
    /// rules match the same element or style too.
    pub consuming: Option<bool>,
    /// The parents the rule applies in: node names or groups separated by
    /// `/`, `//` for any ancestors between, a trailing `/` anchored to the
    /// direct parent, `|` alternatives (`"list_item/"`, `"blockquote//"`).
    pub context: Option<String>,
    /// The node type the rule creates, when it is not the spec's own.
    pub node: Option<String>,
    /// The mark type the rule creates, when it is not the spec's own.
    pub mark: Option<String>,
    /// Fixed attributes of what the rule creates.
    pub attrs: Option<Attrs>,
    /// The attributes computed from the match; `None` from it skips the
    /// rule.
    pub get_attrs: Option<GetAttrs>,
    /// The data form of `get_attrs` (JSON's `getAttrs`): each attribute of
    /// what the rule creates ← the element attribute it is read from.
    pub attrs_from: Option<BTreeMap<String, String>>,
    /// Whether matching content is dropped.
    pub ignore: bool,
    /// Whether the element is skipped, its content parsed in its place.
    pub skip: bool,
    /// Whether the element closes the node it is in.
    pub close_parent: bool,
    /// How the content treats whitespace; the node type's `whitespace` by
    /// default.
    pub preserve_whitespace: Option<Whitespace>,
    /// The selector of the descendant holding the content, instead of the
    /// element itself.
    pub content_element: Option<String>,
    /// For style rules: the active marks to remove instead of adding one.
    pub clear_mark: Option<ClearMark>,
}

impl ParseRule {
    /// A rule matching elements of `selector`.
    pub fn tag(selector: impl Into<String>) -> Self {
        Self {
            tag: Some(selector.into()),
            ..Default::default()
        }
    }

    /// A rule matching the style `style` (`"font-weight"`,
    /// `"font-style=italic"`).
    pub fn style(style: impl Into<String>) -> Self {
        Self {
            style: Some(style.into()),
            ..Default::default()
        }
    }

    /// The rule with fixed `attrs`.
    pub fn with_attrs(mut self, attrs: Attrs) -> Self {
        self.attrs = Some(attrs);
        self
    }

    /// The rule with an attribute callback.
    pub fn with_get_attrs(
        mut self,
        f: impl Fn(RuleInput<'_>) -> Option<Attrs> + Send + Sync + 'static,
    ) -> Self {
        self.get_attrs = Some(GetAttrs::new(f));
        self
    }

    /// The rule's priority (50 by default).
    pub fn effective_priority(&self) -> i32 {
        self.priority.unwrap_or(50)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(tag: &str, attrs: &[(&str, &str)]) -> DomElement {
        DomElement::new(
            tag,
            attrs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            vec![],
        )
    }

    #[test]
    fn selectors() {
        let a = el("a", &[("href", "x"), ("class", "one two"), ("id", "i")]);
        assert!(a.matches("a"));
        assert!(a.matches("A[href]"));
        assert!(a.matches("a[href=x]"));
        assert!(a.matches("a[href=\"x\"]"));
        assert!(!a.matches("a[title]"));
        assert!(a.matches("a.two#i"));
        assert!(a.matches(".one"));
        assert!(a.matches("p, a"));
        assert!(!a.matches("p"));
    }

    #[test]
    fn styles() {
        let b = el("b", &[("style", "Font-Weight: 700 !important; color:red;")]);
        assert_eq!(b.style("font-weight").as_deref(), Some("700"));
        assert_eq!(b.style("color").as_deref(), Some("red"));
        assert_eq!(b.style("margin"), None);
    }
}
