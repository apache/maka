//! Nodes: immutable, shared document trees (`prosemirror-model`'s `node.ts`)
//! and the replace algorithm (`replace.ts`).

use std::{fmt, sync::Arc};

use serde_json::{Map, Value};

use super::{
    Attrs, ContentMatch, Fragment, Mark, MarkType, NodeType, ResolvedPos, Schema, SchemaError,
    Slice, mark::attrs_from_json, resolved::PosError, utf16_len, utf16_slice,
};

/// What `nodes_between` and `descendants` call for each node: the node,
/// its position, its parent and its index there; `false` skips its
/// children.
pub type NodeVisitor<'a> = dyn FnMut(&Node, usize, Option<&Node>, usize) -> bool + 'a;

/// A replacement that does not fit where it is applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplaceError(pub String);

impl fmt::Display for ReplaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReplaceError {}

impl From<PosError> for ReplaceError {
    fn from(e: PosError) -> Self {
        Self(e.to_string())
    }
}

impl From<SchemaError> for ReplaceError {
    fn from(e: SchemaError) -> Self {
        Self(e.to_string())
    }
}

struct NodeInner {
    ty: NodeType,
    attrs: Attrs,
    content: Fragment,
    marks: Vec<Mark>,
    /// For text nodes: the text and its UTF-16 length.
    text: Option<(Arc<str>, usize)>,
}

/// A document node. Immutable and cheap to clone (shared); every change
/// makes new nodes sharing the unchanged parts.
#[derive(Clone)]
pub struct Node(Arc<NodeInner>);

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
            || (self.same_markup(other)
                && self.text() == other.text()
                && self.0.content == other.0.content)
    }
}

impl Eq for Node {}

impl fmt::Display for Node {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut close = 0;
        // The first mark outermost, as ProseMirror's `wrapMarks` writes them.
        for mark in self.0.marks.iter() {
            write!(f, "{}(", mark.ty.name())?;
            close += 1;
        }
        if let Some((text, _)) = &self.0.text {
            write!(f, "{}", Value::String(text.to_string()))?;
        } else {
            f.write_str(self.ty().name())?;
            if self.0.content.size() > 0 {
                f.write_str("(")?;
                self.0.content.fmt_inner(f)?;
                f.write_str(")")?;
            }
        }
        for _ in 0..close {
            f.write_str(")")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Node {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// A child with its index and its start in its parent (`child_after` /
/// `child_before`).
pub type ChildInfo = (Option<Node>, usize, usize);

impl Node {
    pub(crate) fn new(ty: NodeType, attrs: Attrs, content: Fragment, marks: Vec<Mark>) -> Node {
        Node(Arc::new(NodeInner {
            ty,
            attrs,
            content,
            marks,
            text: None,
        }))
    }

    pub(crate) fn new_text(ty: NodeType, text: Arc<str>, marks: Vec<Mark>) -> Node {
        let len = utf16_len(&text);
        Node(Arc::new(NodeInner {
            ty,
            attrs: Attrs::new(),
            content: Fragment::empty(),
            marks,
            text: Some((text, len)),
        }))
    }

    /// Whether `other` is this very node (shared, not only equal): what a
    /// view keeps its rendering of an unchanged node by.
    pub fn ptr_eq(&self, other: &Node) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Its type.
    pub fn ty(&self) -> &NodeType {
        &self.0.ty
    }

    /// Its schema.
    pub fn schema(&self) -> &Schema {
        &self.0.ty.schema
    }

    /// Its attributes.
    pub fn attrs(&self) -> &Attrs {
        &self.0.attrs
    }

    /// Its content.
    pub fn content(&self) -> &Fragment {
        &self.0.content
    }

    /// Its marks, a set.
    pub fn marks(&self) -> &[Mark] {
        &self.0.marks
    }

    /// Its text, for a text node.
    pub fn text(&self) -> Option<&str> {
        self.0.text.as_ref().map(|(t, _)| &**t)
    }

    /// Its text shared, for a text node.
    pub fn text_arc(&self) -> Option<&Arc<str>> {
        self.0.text.as_ref().map(|(t, _)| t)
    }

    /// The UTF-16 length of its text (0 for other nodes).
    pub fn utf16_len(&self) -> usize {
        self.0.text.as_ref().map_or(0, |(_, l)| *l)
    }

    /// Its size: a text's UTF-16 length, 1 for a leaf, else its content's
    /// size plus 2.
    pub fn node_size(&self) -> usize {
        match &self.0.text {
            Some((_, len)) => *len,
            None if self.is_leaf() => 1,
            None => self.0.content.size() + 2,
        }
    }

    /// The number of its children.
    pub fn child_count(&self) -> usize {
        self.0.content.child_count()
    }

    /// The child at `index`; panics past the end.
    pub fn child(&self, index: usize) -> &Node {
        self.0.content.child(index)
    }

    /// The child at `index`, if any.
    pub fn maybe_child(&self, index: usize) -> Option<&Node> {
        self.0.content.maybe_child(index)
    }

    /// Its first child.
    pub fn first_child(&self) -> Option<&Node> {
        self.0.content.first_child()
    }

    /// Its last child.
    pub fn last_child(&self) -> Option<&Node> {
        self.0.content.last_child()
    }

    /// Whether it is a text node.
    pub fn is_text(&self) -> bool {
        self.0.text.is_some()
    }

    /// Whether it is inline.
    pub fn is_inline(&self) -> bool {
        self.ty().is_inline()
    }

    /// Whether it is a block.
    pub fn is_block(&self) -> bool {
        self.ty().is_block()
    }

    /// Whether it is a block with inline content.
    pub fn is_textblock(&self) -> bool {
        self.ty().is_textblock()
    }

    /// Whether its content is inline.
    pub fn inline_content(&self) -> bool {
        self.ty().inline_content()
    }

    /// Whether it allows no content.
    pub fn is_leaf(&self) -> bool {
        self.ty().is_leaf()
    }

    /// Whether it is a leaf or an atom.
    pub fn is_atom(&self) -> bool {
        self.ty().is_atom()
    }

    /// The text of the node and its descendants (leaf text from the
    /// types' `leaf_text`).
    pub fn text_content(&self) -> String {
        match self.text() {
            Some(t) => t.to_owned(),
            None if self.is_leaf() => self.ty().spec().leaf_text.clone().unwrap_or_default(),
            None => self.text_between(0, self.0.content.size(), Some(""), None),
        }
    }

    /// The text between `from` and `to`, `block_separator` between blocks,
    /// `leaf_text` (or the leaf's type's `leaf_text`) for leaves.
    pub fn text_between(
        &self,
        from: usize,
        to: usize,
        block_separator: Option<&str>,
        leaf_text: Option<&str>,
    ) -> String {
        self.0
            .content
            .text_between(from, to, block_separator, leaf_text)
    }

    /// Whether it has the type, attributes and marks of `other`.
    pub fn same_markup(&self, other: &Node) -> bool {
        self.has_markup(other.ty(), Some(other.attrs()), Some(other.marks()))
    }

    /// Whether it has this type, attributes (default ones when none) and
    /// marks (none when none).
    pub fn has_markup(&self, ty: &NodeType, attrs: Option<&Attrs>, marks: Option<&[Mark]>) -> bool {
        if self.ty() != ty {
            return false;
        }
        let attrs_eq = match attrs {
            Some(a) => &self.0.attrs == a,
            None => Some(&self.0.attrs) == ty.default_attrs().as_ref(),
        };
        attrs_eq && Mark::same_set(&self.0.marks, marks.unwrap_or(&[]))
    }

    /// The same markup with other content.
    pub fn copy(&self, content: Fragment) -> Node {
        if content == self.0.content || self.is_text() {
            return self.clone();
        }
        Node::new(
            self.0.ty.clone(),
            self.0.attrs.clone(),
            content,
            self.0.marks.clone(),
        )
    }

    /// The same node with other marks.
    pub fn mark(&self, marks: Vec<Mark>) -> Node {
        if marks == self.0.marks {
            return self.clone();
        }
        Node(Arc::new(NodeInner {
            ty: self.0.ty.clone(),
            attrs: self.0.attrs.clone(),
            content: self.0.content.clone(),
            marks,
            text: self.0.text.clone(),
        }))
    }

    /// A text node's same markup with another text (other nodes are
    /// returned unchanged).
    pub fn with_text(&self, text: impl Into<Arc<str>>) -> Node {
        let text: Arc<str> = text.into();
        match &self.0.text {
            Some((t, _)) if **t == *text => self.clone(),
            Some(_) => Node::new_text(self.0.ty.clone(), text, self.0.marks.clone()),
            None => self.clone(),
        }
    }

    /// The part of the node between `from` and `to` (offsets in its content,
    /// or in its text for a text node).
    pub fn cut(&self, from: usize, to: usize) -> Node {
        if let Some((text, len)) = &self.0.text {
            let to = to.min(*len);
            if from == 0 && to == *len {
                return self.clone();
            }
            return self.with_text(utf16_slice(text, from, to));
        }
        let to = to.min(self.0.content.size());
        if from == 0 && to == self.0.content.size() {
            return self.clone();
        }
        self.copy(self.0.content.cut(from, to))
    }

    /// The document between `from` and `to` as a slice; with
    /// `include_parents` it is open up to the root.
    pub fn slice(&self, from: usize, to: usize, include_parents: bool) -> Result<Slice, PosError> {
        if from == to {
            return Ok(Slice::empty());
        }
        let rfrom = self.resolve(from)?;
        let rto = self.resolve(to)?;
        let depth = if include_parents {
            0
        } else {
            rfrom.shared_depth(to)
        };
        let start = rfrom.start(depth);
        let node = rfrom.node(depth);
        let content = node.content().cut(rfrom.pos - start, rto.pos - start);
        Ok(Slice::new(content, rfrom.depth - depth, rto.depth - depth))
    }

    /// The document with `from..to` replaced by `slice`, if the slice fits.
    pub fn replace(&self, from: usize, to: usize, slice: &Slice) -> Result<Node, ReplaceError> {
        replace(&self.resolve(from)?, &self.resolve(to)?, slice)
    }

    /// The node at `pos` (directly after it).
    pub fn node_at(&self, pos: usize) -> Option<Node> {
        let mut node = self.clone();
        let mut pos = pos;
        loop {
            let (index, offset) = node.0.content.find_index(pos, -1);
            let child = node.maybe_child(index)?.clone();
            if offset == pos || child.is_text() {
                return Some(child);
            }
            pos -= offset + 1;
            node = child;
        }
    }

    /// The direct child at or after the content offset `pos`, its index and
    /// start.
    pub fn child_after(&self, pos: usize) -> ChildInfo {
        let (index, offset) = self.0.content.find_index(pos, -1);
        (self.maybe_child(index).cloned(), index, offset)
    }

    /// The direct child before the content offset `pos`, its index and start.
    pub fn child_before(&self, pos: usize) -> ChildInfo {
        if pos == 0 {
            return (None, 0, 0);
        }
        let (index, offset) = self.0.content.find_index(pos, -1);
        if offset < pos {
            return (Some(self.child(index).clone()), index, offset);
        }
        let node = self.child(index - 1).clone();
        let size = node.node_size();
        (Some(node), index - 1, offset - size)
    }

    /// Calls `f` for every descendant overlapping `from..to`, with its
    /// position, parent and index; descends unless `f` returns false.
    pub fn nodes_between(&self, from: usize, to: usize, f: &mut NodeVisitor<'_>) {
        self.0.content.nodes_between_at(from, to, f, 0, Some(self))
    }

    /// Calls `f` for every descendant.
    pub fn descendants(&self, f: &mut NodeVisitor<'_>) {
        self.nodes_between(0, self.0.content.size(), f)
    }

    /// Calls `f` for every direct child with its offset and index.
    pub fn for_each(&self, f: &mut dyn FnMut(&Node, usize, usize)) {
        let mut pos = 0;
        for (i, child) in self.0.content.iter().enumerate() {
            f(child, pos, i);
            pos += child.node_size();
        }
    }

    /// Resolves a position in this node's content.
    pub fn resolve(&self, pos: usize) -> Result<ResolvedPos, PosError> {
        ResolvedPos::resolve(self, pos)
    }

    /// Whether a mark of `ty` is on some inline node in `from..to`.
    pub fn range_has_mark(&self, from: usize, to: usize, ty: &MarkType) -> bool {
        let mut found = false;
        if to > from {
            self.nodes_between(from, to, &mut |node, _, _, _| {
                if ty.is_in_set(node.marks()).is_some() {
                    found = true;
                }
                !found
            });
        }
        found
    }

    /// The content match after the first `index` children, or after the
    /// children before them that match where the content is invalid (where
    /// ProseMirror throws); see [`Node::content_match_at`].
    pub fn content_match_at_lenient(&self, index: usize) -> ContentMatch {
        let mut cur = self.ty().content_match();
        for child in self.0.content.iter().take(index) {
            match cur.match_type(child.ty()) {
                Some(next) => cur = next,
                None => break,
            }
        }
        cur
    }

    /// The content match after the first `index` children; none when they
    /// do not match (the content is invalid).
    pub fn content_match_at(&self, index: usize) -> Option<ContentMatch> {
        self.ty()
            .content_match()
            .match_fragment(&self.0.content, 0, index)
    }

    /// Whether replacing the children `from..to` with
    /// `replacement[start..end]` leaves valid content.
    pub fn can_replace(
        &self,
        from: usize,
        to: usize,
        replacement: &Fragment,
        start: usize,
        end: usize,
    ) -> bool {
        let Some(one) = self
            .content_match_at(from)
            .and_then(|m| m.match_fragment(replacement, start, end))
        else {
            return false;
        };
        let Some(two) = one.match_fragment(&self.0.content, to, self.child_count()) else {
            return false;
        };
        if !two.valid_end() {
            return false;
        }
        (start..end.min(replacement.child_count()))
            .all(|i| self.ty().allows_marks(replacement.child(i).marks()))
    }

    /// Whether replacing the children `from..to` with a node of `ty` (and
    /// `marks`) leaves valid content.
    pub fn can_replace_with(
        &self,
        from: usize,
        to: usize,
        ty: &NodeType,
        marks: Option<&[Mark]>,
    ) -> bool {
        if marks.is_some_and(|m| !self.ty().allows_marks(m)) {
            return false;
        }
        let Some(start) = self.content_match_at(from).and_then(|m| m.match_type(ty)) else {
            return false;
        };
        start
            .match_fragment(&self.0.content, to, self.child_count())
            .is_some_and(|m| m.valid_end())
    }

    /// Whether `other`'s content may be appended to this node's.
    pub fn can_append(&self, other: &Node) -> bool {
        if other.content().size() > 0 {
            self.can_replace(
                self.child_count(),
                self.child_count(),
                other.content(),
                0,
                other.child_count(),
            )
        } else {
            self.ty().compatible_content(other.ty())
        }
    }

    /// Checks the node and its descendants against the schema: content,
    /// attributes, marks; and no empty texts.
    pub fn check(&self) -> Result<(), SchemaError> {
        if let Some((_, 0)) = &self.0.text {
            return Err(SchemaError::InvalidContent(
                "Empty text nodes are not allowed".into(),
            ));
        }
        if !self.is_text() {
            self.ty().check_content(&self.0.content)?;
            self.ty().check_attrs(&self.0.attrs)?;
        }
        let mut copy: Vec<Mark> = Vec::new();
        for mark in &self.0.marks {
            mark.ty.check_attrs(&mark.attrs)?;
            copy = mark.add_to_set(&copy);
        }
        if !Mark::same_set(&copy, &self.0.marks) {
            let names: Vec<&str> = self.0.marks.iter().map(|m| m.ty.name()).collect();
            return Err(SchemaError::InvalidContent(format!(
                "Invalid collection of marks for node {}: {}",
                self.ty().name(),
                names.join(", ")
            )));
        }
        for child in self.0.content.iter() {
            child.check()?;
        }
        Ok(())
    }

    /// ProseMirror's JSON: `{type, attrs?, content?, marks?, text?}`.
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("type".into(), Value::String(self.ty().name().into()));
        if !self.0.attrs.is_empty() {
            obj.insert(
                "attrs".into(),
                Value::Object(self.0.attrs.clone().into_iter().collect()),
            );
        }
        if self.0.content.size() > 0 {
            obj.insert("content".into(), self.0.content.to_json());
        }
        if !self.0.marks.is_empty() {
            obj.insert(
                "marks".into(),
                Value::Array(self.0.marks.iter().map(Mark::to_json).collect()),
            );
        }
        if let Some(text) = self.text() {
            obj.insert("text".into(), Value::String(text.into()));
        }
        Value::Object(obj)
    }

    /// Reads ProseMirror's JSON, checking attributes (not content: see
    /// [`Node::check`]).
    pub fn from_json(schema: &Schema, json: &Value) -> Result<Node, SchemaError> {
        let bad = || SchemaError::Json("Invalid input for Node.fromJSON".into());
        let obj = json.as_object().ok_or_else(bad)?;
        let marks = match obj.get("marks") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|m| Mark::from_json(schema, m))
                .collect::<Result<_, _>>()?,
            Some(_) => {
                return Err(SchemaError::Json(
                    "Invalid mark data for Node.fromJSON".into(),
                ));
            }
        };
        let name = obj.get("type").and_then(Value::as_str).ok_or_else(bad)?;
        if name == "text" {
            let text = obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| SchemaError::Json("Invalid text node in JSON".into()))?;
            return Ok(schema.text(text, marks));
        }
        let ty = schema.node_type(name).ok_or_else(|| {
            SchemaError::Json(format!("There is no node type {name} in this schema"))
        })?;
        let content = Fragment::from_json(schema, obj.get("content").unwrap_or(&Value::Null))?;
        let node = ty.create(attrs_from_json(obj.get("attrs"))?, content, marks)?;
        ty.check_attrs(node.attrs())?;
        Ok(node)
    }
}

// replace.ts

/// Replaces `from..to` (resolved in the same document) with `slice`.
pub(crate) fn replace(
    from: &ResolvedPos,
    to: &ResolvedPos,
    slice: &Slice,
) -> Result<Node, ReplaceError> {
    if slice.open_start > from.depth {
        return Err(ReplaceError(
            "Inserted content deeper than insertion position".into(),
        ));
    }
    if slice.open_end > to.depth || from.depth - slice.open_start != to.depth - slice.open_end {
        return Err(ReplaceError("Inconsistent open depths".into()));
    }
    replace_outer(from, to, slice, 0)
}

fn replace_outer(
    from: &ResolvedPos,
    to: &ResolvedPos,
    slice: &Slice,
    depth: usize,
) -> Result<Node, ReplaceError> {
    let index = from.index(depth);
    let node = from.node(depth);
    if index == to.index(depth) && depth < from.depth - slice.open_start {
        let inner = replace_outer(from, to, slice, depth + 1)?;
        Ok(node.copy(node.content().replace_child(index, inner)))
    } else if slice.content.size() == 0 {
        close(node, replace_two_way(from, to, depth)?)
    } else if slice.open_start == 0
        && slice.open_end == 0
        && from.depth == depth
        && to.depth == depth
    {
        let parent = from.parent();
        let content = parent.content();
        close(
            parent,
            content
                .cut(0, from.parent_offset)
                .append(&slice.content)
                .append(&content.cut(to.parent_offset, content.size())),
        )
    } else {
        let (start, end) = prepare_slice_for_replace(slice, from)?;
        close(node, replace_three_way(from, &start, &end, to, depth)?)
    }
}

fn check_join(main: &Node, sub: &Node) -> Result<(), ReplaceError> {
    if !sub.ty().compatible_content(main.ty()) {
        return Err(ReplaceError(format!(
            "Cannot join {} onto {}",
            sub.ty().name(),
            main.ty().name()
        )));
    }
    Ok(())
}

fn joinable(before: &ResolvedPos, after: &ResolvedPos, depth: usize) -> Result<Node, ReplaceError> {
    let node = before.node(depth);
    check_join(node, after.node(depth))?;
    Ok(node.clone())
}

fn add_node(child: Node, target: &mut Vec<Node>) {
    if let Some(last) = target.last_mut()
        && child.is_text()
        && child.same_markup(last)
    {
        let text = format!(
            "{}{}",
            last.text().unwrap_or(""),
            child.text().unwrap_or("")
        );
        *last = child.with_text(text);
        return;
    }
    target.push(child);
}

fn add_range(
    start: Option<&ResolvedPos>,
    end: Option<&ResolvedPos>,
    depth: usize,
    target: &mut Vec<Node>,
) {
    let node = end.or(start).expect("a range has a side").node(depth);
    let mut start_index = 0;
    let end_index = end.map_or(node.child_count(), |e| e.index(depth));
    if let Some(start) = start {
        start_index = start.index(depth);
        if start.depth > depth {
            start_index += 1;
        } else if start.text_offset() > 0 {
            if let Some(after) = start.node_after() {
                add_node(after, target);
            }
            start_index += 1;
        }
    }
    for i in start_index..end_index {
        add_node(node.child(i).clone(), target);
    }
    if let Some(end) = end
        && end.depth == depth
        && end.text_offset() > 0
        && let Some(before) = end.node_before()
    {
        add_node(before, target);
    }
}

fn close(node: &Node, content: Fragment) -> Result<Node, ReplaceError> {
    node.ty().check_content(&content)?;
    Ok(node.copy(content))
}

fn replace_three_way(
    from: &ResolvedPos,
    start: &ResolvedPos,
    end: &ResolvedPos,
    to: &ResolvedPos,
    depth: usize,
) -> Result<Fragment, ReplaceError> {
    let open_start = if from.depth > depth {
        Some(joinable(from, start, depth + 1)?)
    } else {
        None
    };
    let open_end = if to.depth > depth {
        Some(joinable(end, to, depth + 1)?)
    } else {
        None
    };
    let mut content = Vec::new();
    add_range(None, Some(from), depth, &mut content);
    match (&open_start, &open_end) {
        (Some(os), Some(oe)) if start.index(depth) == end.index(depth) => {
            check_join(os, oe)?;
            add_node(
                close(os, replace_three_way(from, start, end, to, depth + 1)?)?,
                &mut content,
            );
        }
        _ => {
            if let Some(os) = &open_start {
                add_node(
                    close(os, replace_two_way(from, start, depth + 1)?)?,
                    &mut content,
                );
            }
            add_range(Some(start), Some(end), depth, &mut content);
            if let Some(oe) = &open_end {
                add_node(
                    close(oe, replace_two_way(end, to, depth + 1)?)?,
                    &mut content,
                );
            }
        }
    }
    add_range(Some(to), None, depth, &mut content);
    Ok(Fragment::from_joined(content))
}

fn replace_two_way(
    from: &ResolvedPos,
    to: &ResolvedPos,
    depth: usize,
) -> Result<Fragment, ReplaceError> {
    let mut content = Vec::new();
    add_range(None, Some(from), depth, &mut content);
    if from.depth > depth {
        let ty = joinable(from, to, depth + 1)?;
        add_node(
            close(&ty, replace_two_way(from, to, depth + 1)?)?,
            &mut content,
        );
    }
    add_range(Some(to), None, depth, &mut content);
    Ok(Fragment::from_joined(content))
}

fn prepare_slice_for_replace(
    slice: &Slice,
    along: &ResolvedPos,
) -> Result<(ResolvedPos, ResolvedPos), ReplaceError> {
    let extra = along.depth - slice.open_start;
    let parent = along.node(extra);
    let mut node = parent.copy(slice.content.clone());
    for i in (0..extra).rev() {
        node = along.node(i).copy(Fragment::from(node));
    }
    let start = node.resolve(slice.open_start + extra)?;
    let end = node.resolve(node.content().size() - slice.open_end - extra)?;
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::model::test_schema::*;

    fn bq(s: &Schema, c: Vec<Node>) -> Node {
        n(s, "blockquote", c)
    }

    #[test]
    fn sizes_and_display() {
        let s = schema();
        let d = doc(
            &s,
            vec![
                p(&s, vec![t(&s, "ab"), tm(&s, "c", &["em"])]),
                n(&s, "horizontal_rule", vec![]),
            ],
        );
        assert_eq!(d.node_size(), 2 + 5 + 1);
        assert_eq!(
            d.to_string(),
            "doc(paragraph(\"ab\", em(\"c\")), horizontal_rule)"
        );
        assert_eq!(d.text_content(), "abc");
        assert_eq!(d.node_at(0).unwrap().ty().name(), "paragraph");
        assert_eq!(d.node_at(1).unwrap().text(), Some("ab"));
        assert_eq!(d.node_at(2).unwrap().text(), Some("ab"));
        assert_eq!(d.node_at(3).unwrap().text(), Some("c"));
        assert_eq!(d.node_at(5).unwrap().ty().name(), "horizontal_rule");
        assert!(d.node_at(6).is_none());
        let (c, i, o) = d.child_before(5);
        assert_eq!(
            (c.unwrap().ty().name().to_owned(), i, o),
            ("paragraph".into(), 0, 0)
        );
        let (c, i, o) = d.child_after(5);
        assert_eq!(
            (c.unwrap().ty().name().to_owned(), i, o),
            ("horizontal_rule".into(), 1, 5)
        );
    }

    fn rep(d: &Node, from: usize, to: usize, slice: &Slice) -> Result<String, ReplaceError> {
        d.replace(from, to, slice).map(|n| n.to_string())
    }

    #[test]
    fn replace_basic() {
        let s = schema();
        let d = doc(
            &s,
            vec![p(&s, vec![t(&s, "hello")]), p(&s, vec![t(&s, "world")])],
        );
        // Delete across paragraphs joins them.
        assert_eq!(
            rep(&d, 3, 10, &Slice::empty()).unwrap(),
            "doc(paragraph(\"herld\"))"
        );
        // Flat insert of text.
        let sl = Slice::new(Fragment::from(t(&s, "XY")), 0, 0);
        assert_eq!(
            rep(&d, 2, 2, &sl).unwrap(),
            "doc(paragraph(\"hXYello\"), paragraph(\"world\"))"
        );
        // An open slice of two paragraphs splits the target.
        let sl = d.slice(3, 10, false).unwrap();
        assert_eq!((sl.open_start, sl.open_end), (1, 1));
        assert_eq!(
            rep(&d, 2, 2, &sl).unwrap(),
            "doc(paragraph(\"hllo\"), paragraph(\"woello\"), paragraph(\"world\"))"
        );
        // Whole document replaced by itself.
        let all = d.slice(0, d.content().size(), false).unwrap();
        assert_eq!(d.replace(0, d.content().size(), &all).unwrap(), d);
    }

    #[test]
    fn replace_errors() {
        let s = schema();
        let d = doc(&s, vec![p(&s, vec![t(&s, "ab")])]);
        // A closed paragraph inside a paragraph is invalid content.
        let sl = Slice::new(Fragment::from(p(&s, vec![t(&s, "x")])), 0, 0);
        assert!(d.replace(2, 2, &sl).is_err());
        let open = Slice::new(Fragment::from(p(&s, vec![t(&s, "x")])), 2, 0);
        assert!(d.replace(2, 2, &open).is_err(), "deeper than insertion");
        let inconsistent = Slice::new(Fragment::from(p(&s, vec![t(&s, "x")])), 1, 0);
        assert!(d.replace(2, 2, &inconsistent).is_err());
        // Joining a code block onto a list is impossible.
        let d2 = doc(
            &s,
            vec![
                n(
                    &s,
                    "bullet_list",
                    vec![n(&s, "list_item", vec![p(&s, vec![t(&s, "a")])])],
                ),
                n(&s, "code_block", vec![t(&s, "b")]),
            ],
        );
        assert!(d2.replace(2, 10, &Slice::empty()).is_err());
        assert!(d.replace(0, 99, &Slice::empty()).is_err());
    }

    #[test]
    fn replace_open_slices_nested() {
        let s = schema();
        let d = doc(
            &s,
            vec![
                bq(&s, vec![p(&s, vec![t(&s, "abc")])]),
                p(&s, vec![t(&s, "def")]),
            ],
        );
        // Delete from inside the quote to inside the paragraph after it.
        // Its open depths differ (2 and 1): `Node::replace` refuses it, as
        // ProseMirror's does; `Transform::delete` fits it instead.
        assert!(rep(&d, 3, 10, &Slice::empty()).is_err());
        // Insert a slice open on both sides cut from a quote into a paragraph.
        let src = doc(
            &s,
            vec![bq(
                &s,
                vec![p(&s, vec![t(&s, "one")]), p(&s, vec![t(&s, "two")])],
            )],
        );
        let sl = src.slice(3, 10, false).unwrap();
        assert_eq!(
            sl.to_string(),
            "<paragraph(\"ne\"), paragraph(\"two\")>(1,1)"
        );
        assert_eq!(
            rep(&d, 9, 9, &sl).unwrap(),
            "doc(blockquote(paragraph(\"abc\")), paragraph(\"dne\"), paragraph(\"twoef\"))"
        );
        // Text slice with marks joins its text where markup matches.
        let sl = Slice::new(Fragment::from(tm(&s, "Z", &["em"])), 0, 0);
        let out = d.replace(3, 3, &sl).unwrap();
        out.check().unwrap();
        assert_eq!(
            out.to_string(),
            "doc(blockquote(paragraph(\"a\", em(\"Z\"), \"bc\")), paragraph(\"def\"))"
        );
    }

    #[test]
    fn replace_utf16() {
        let s = schema();
        let d = doc(&s, vec![p(&s, vec![t(&s, "a😀中b")])]);
        assert_eq!(d.content().size(), 2 + 5);
        assert_eq!(
            rep(&d, 2, 4, &Slice::empty()).unwrap(),
            "doc(paragraph(\"a中b\"))"
        );
        assert_eq!(d.text_between(2, 5, None, None), "😀中");
        let sl = d.slice(4, 5, false).unwrap();
        assert_eq!(sl.content.child(0).text(), Some("中"));
    }

    #[test]
    fn can_replace_and_check() {
        let s = schema();
        let d = doc(&s, vec![p(&s, vec![t(&s, "a")])]);
        assert!(d.can_replace(
            0,
            1,
            &Fragment::from(n(&s, "horizontal_rule", vec![])),
            0,
            1
        ));
        assert!(
            !d.can_replace(0, 1, &Fragment::empty(), 0, 0),
            "doc needs a block"
        );
        assert!(d.can_replace_with(1, 1, s.node_type("heading").as_ref().unwrap(), None));
        assert!(!d.can_replace_with(1, 1, &s.text_type(), None));
        d.check().unwrap();
        let bad = s
            .node_type("doc")
            .unwrap()
            .create(None, Fragment::from(t(&s, "x")), vec![])
            .unwrap();
        assert!(bad.check().is_err());
        let em = s.mark("em", None).unwrap();
        let code = s
            .node_type("code_block")
            .unwrap()
            .create(None, Fragment::from(s.text("x", vec![em])), vec![])
            .unwrap();
        assert!(code.check().is_err(), "code blocks allow no marks");
        assert!(
            doc(&s, vec![p(&s, vec![t(&s, "")])]).check().is_ok(),
            "empty texts are dropped"
        );
        assert!(s.text("", vec![]).check().is_err());
        assert!(!d.range_has_mark(0, 3, &s.mark_type("em").unwrap()));
    }

    #[test]
    fn json_roundtrip() {
        let s = schema();
        let mut href = Attrs::new();
        href.insert("href".into(), json!("u"));
        let link = s.mark("link", Some(href)).unwrap();
        let d = doc(
            &s,
            vec![
                n(&s, "heading", vec![t(&s, "T")]),
                p(&s, vec![s.text("l😀", vec![link]), t(&s, "x")]),
            ],
        );
        let j = d.to_json();
        assert_eq!(
            j["content"][0],
            json!({"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "T"}]})
        );
        assert_eq!(
            j["content"][1]["content"][0]["marks"][0]["attrs"]["href"],
            json!("u")
        );
        let back = Node::from_json(&s, &j).unwrap();
        assert_eq!(back, d);
        assert!(Node::from_json(&s, &json!({"type": "nope"})).is_err());
        assert!(Node::from_json(&s, &json!({"type": "heading", "attrs": {"level": "x"}})).is_err());
    }
}
