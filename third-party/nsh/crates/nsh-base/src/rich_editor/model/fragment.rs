//! Fragments: a node's children, immutable and shared.

use std::{fmt, sync::Arc};

use serde_json::Value;

use super::{Node, NodeVisitor, Schema, SchemaError};

/// A sequence of nodes, a node's content. Cheap to clone. Adjacent texts of
/// the same marks are always joined and empty texts dropped.
#[derive(Clone)]
pub struct Fragment {
    nodes: Arc<[Node]>,
    size: usize,
}

impl Default for Fragment {
    fn default() -> Self {
        Self::empty()
    }
}

impl PartialEq for Fragment {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.nodes, &other.nodes) || self.nodes[..] == other.nodes[..]
    }
}

impl Eq for Fragment {}

impl fmt::Display for Fragment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<")?;
        self.fmt_inner(f)?;
        f.write_str(">")
    }
}

impl fmt::Debug for Fragment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl From<Vec<Node>> for Fragment {
    fn from(nodes: Vec<Node>) -> Self {
        let mut joined: Vec<Node> = Vec::with_capacity(nodes.len());
        for node in nodes {
            if node.is_text() && node.node_size() == 0 {
                continue;
            }
            if let Some(last) = joined.last_mut()
                && node.is_text()
                && last.same_markup(&node)
            {
                let text = format!("{}{}", last.text().unwrap_or(""), node.text().unwrap_or(""));
                *last = last.with_text(text);
                continue;
            }
            joined.push(node);
        }
        Self::from_joined(joined)
    }
}

impl From<Node> for Fragment {
    fn from(node: Node) -> Self {
        Self::from(vec![node])
    }
}

impl From<Option<Node>> for Fragment {
    fn from(node: Option<Node>) -> Self {
        node.map_or_else(Self::empty, Self::from)
    }
}

impl<'a> IntoIterator for &'a Fragment {
    type Item = &'a Node;
    type IntoIter = std::slice::Iter<'a, Node>;

    fn into_iter(self) -> Self::IntoIter {
        self.nodes.iter()
    }
}

impl Fragment {
    /// A fragment of nodes known to be joined already.
    pub(crate) fn from_joined(nodes: Vec<Node>) -> Self {
        let size = nodes.iter().map(Node::node_size).sum();
        Self {
            nodes: nodes.into(),
            size,
        }
    }

    /// The empty fragment.
    pub fn empty() -> Self {
        Self {
            nodes: Arc::from([]),
            size: 0,
        }
    }

    /// Its size: the sum of its children's sizes.
    pub fn size(&self) -> usize {
        self.size
    }

    /// The number of its children.
    pub fn child_count(&self) -> usize {
        self.nodes.len()
    }

    /// Its children.
    pub fn children(&self) -> &[Node] {
        &self.nodes
    }

    /// Its children, in order.
    pub fn iter(&self) -> std::slice::Iter<'_, Node> {
        self.nodes.iter()
    }

    /// The child at `index`; panics past the end.
    pub fn child(&self, index: usize) -> &Node {
        &self.nodes[index]
    }

    /// The child at `index`, if any.
    pub fn maybe_child(&self, index: usize) -> Option<&Node> {
        self.nodes.get(index)
    }

    /// Its first child.
    pub fn first_child(&self) -> Option<&Node> {
        self.nodes.first()
    }

    /// Its last child.
    pub fn last_child(&self) -> Option<&Node> {
        self.nodes.last()
    }

    /// Calls `f` for every node overlapping `from..to` (relative to its
    /// start), with its position, parent and index; descends into a node's
    /// content unless `f` returns false.
    pub fn nodes_between(&self, from: usize, to: usize, f: &mut NodeVisitor<'_>) {
        self.nodes_between_at(from, to, f, 0, None)
    }

    /// [`Fragment::nodes_between`] with positions offset by `node_start` and
    /// `parent` passed to `f` for direct children.
    pub fn nodes_between_at(
        &self,
        from: usize,
        to: usize,
        f: &mut NodeVisitor<'_>,
        node_start: usize,
        parent: Option<&Node>,
    ) {
        let mut pos = 0;
        for (i, child) in self.nodes.iter().enumerate() {
            if pos >= to {
                break;
            }
            let end = pos + child.node_size();
            if end > from && f(child, node_start + pos, parent, i) && child.content().size() > 0 {
                let start = pos + 1;
                child.content().nodes_between_at(
                    from.saturating_sub(start),
                    child.content().size().min(to.saturating_sub(start)),
                    f,
                    node_start + start,
                    Some(child),
                );
            }
            pos = end;
        }
    }

    /// Calls `f` for every descendant.
    pub fn descendants(&self, f: &mut NodeVisitor<'_>) {
        self.nodes_between(0, self.size, f)
    }

    /// The text between `from` and `to`, `block_separator` between blocks
    /// and `leaf_text` for leaves that are not text.
    pub fn text_between(
        &self,
        from: usize,
        to: usize,
        block_separator: Option<&str>,
        leaf_text: Option<&str>,
    ) -> String {
        let mut text = String::new();
        let mut first = true;
        self.nodes_between(from, to, &mut |node, pos, _, _| {
            let node_text: &str = if let Some(t) = node.text() {
                super::utf16_slice(t, from.max(pos) - pos, to - pos)
            } else if !node.is_leaf() {
                ""
            } else {
                leaf_text
                    .or(node.ty().spec().leaf_text.as_deref())
                    .unwrap_or("")
            };
            if node.is_block()
                && (node.is_leaf() && !node_text.is_empty() || node.is_textblock())
                && let Some(sep) = block_separator
            {
                if first {
                    first = false;
                } else {
                    text.push_str(sep);
                }
            }
            text.push_str(node_text);
            true
        });
        text
    }

    /// This fragment followed by `other`, joining texts at the seam.
    pub fn append(&self, other: &Fragment) -> Fragment {
        if other.size == 0 {
            return self.clone();
        }
        if self.size == 0 {
            return other.clone();
        }
        let mut content: Vec<Node> = self.nodes.to_vec();
        let mut rest = &other.nodes[..];
        let last = content.last().unwrap();
        let first = &other.nodes[0];
        if last.is_text() && last.same_markup(first) {
            let text = format!(
                "{}{}",
                last.text().unwrap_or(""),
                first.text().unwrap_or("")
            );
            let joined = last.with_text(text);
            *content.last_mut().unwrap() = joined;
            rest = &rest[1..];
        }
        content.extend(rest.iter().cloned());
        Fragment {
            nodes: content.into(),
            size: self.size + other.size,
        }
    }

    /// The part between `from` and `to`, cutting nodes that cross them.
    pub fn cut(&self, from: usize, to: usize) -> Fragment {
        let to = to.min(self.size);
        if from == 0 && to == self.size {
            return self.clone();
        }
        let mut result = Vec::new();
        let mut size = 0;
        if to > from {
            let mut pos = 0;
            for child in self.nodes.iter() {
                if pos >= to {
                    break;
                }
                let end = pos + child.node_size();
                if end > from {
                    let child = if pos < from || end > to {
                        if child.is_text() {
                            child.cut(from.saturating_sub(pos), child.node_size().min(to - pos))
                        } else {
                            child.cut(
                                from.saturating_sub(pos + 1),
                                child.content().size().min(to.saturating_sub(pos + 1)),
                            )
                        }
                    } else {
                        child.clone()
                    };
                    size += child.node_size();
                    result.push(child);
                }
                pos = end;
            }
        }
        Fragment {
            nodes: result.into(),
            size,
        }
    }

    /// The children `from..to`.
    pub fn cut_by_index(&self, from: usize, to: usize) -> Fragment {
        if from == to {
            return Fragment::empty();
        }
        if from == 0 && to == self.nodes.len() {
            return self.clone();
        }
        Fragment::from_joined(self.nodes[from..to].to_vec())
    }

    /// This fragment with the child at `index` replaced by `node`.
    pub fn replace_child(&self, index: usize, node: Node) -> Fragment {
        let current = &self.nodes[index];
        if *current == node {
            return self.clone();
        }
        let size = self.size + node.node_size() - current.node_size();
        let mut copy = self.nodes.to_vec();
        copy[index] = node;
        Fragment {
            nodes: copy.into(),
            size,
        }
    }

    /// This fragment with `node` added first.
    pub fn add_to_start(&self, node: Node) -> Fragment {
        Fragment::from(vec![node]).append(self)
    }

    /// This fragment with `node` added last.
    pub fn add_to_end(&self, node: Node) -> Fragment {
        self.append(&Fragment::from(vec![node]))
    }

    /// The index of the child at `pos` and that child's start. A `pos` on a
    /// boundary gives the child after it; inside a child, `round > 0` gives
    /// the one after. Positions past the end are clamped.
    pub fn find_index(&self, pos: usize, round: i32) -> (usize, usize) {
        if pos == 0 {
            return (0, 0);
        }
        if pos >= self.size {
            return (self.nodes.len(), self.size);
        }
        let mut cur = 0;
        for (i, child) in self.nodes.iter().enumerate() {
            let end = cur + child.node_size();
            if end >= pos {
                if end == pos || round > 0 {
                    return (i + 1, end);
                }
                return (i, cur);
            }
            cur = end;
        }
        (self.nodes.len(), self.size)
    }

    /// The position where this fragment and `other` start to differ.
    pub fn find_diff_start(&self, other: &Fragment, pos: usize) -> Option<usize> {
        let mut pos = pos;
        let mut i = 0;
        loop {
            if i == self.child_count() || i == other.child_count() {
                return (self.child_count() != other.child_count()).then_some(pos);
            }
            let (a, b) = (self.child(i), other.child(i));
            if a == b {
                pos += a.node_size();
                i += 1;
                continue;
            }
            if !a.same_markup(b) {
                return Some(pos);
            }
            if let (Some(ta), Some(tb)) = (a.text(), b.text())
                && ta != tb
            {
                let mut p = pos;
                for (ca, cb) in ta.chars().zip(tb.chars()) {
                    if ca != cb {
                        break;
                    }
                    p += ca.len_utf16();
                }
                return Some(p);
            }
            if (a.content().size() > 0 || b.content().size() > 0)
                && let Some(inner) = a.content().find_diff_start(b.content(), pos + 1)
            {
                return Some(inner);
            }
            pos += a.node_size();
            i += 1;
        }
    }

    /// ProseMirror's JSON: an array of nodes, or null when empty.
    pub fn to_json(&self) -> Value {
        if self.nodes.is_empty() {
            Value::Null
        } else {
            Value::Array(self.nodes.iter().map(Node::to_json).collect())
        }
    }

    /// Reads ProseMirror's JSON (an array of nodes, or null).
    pub fn from_json(schema: &Schema, json: &Value) -> Result<Fragment, SchemaError> {
        match json {
            Value::Null => Ok(Fragment::empty()),
            Value::Array(items) => Ok(Fragment::from(
                items
                    .iter()
                    .map(|v| Node::from_json(schema, v))
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            _ => Err(SchemaError::Json(
                "Invalid input for Fragment.fromJSON".into(),
            )),
        }
    }

    pub(crate) fn fmt_inner(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, node) in self.nodes.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            fmt::Display::fmt(node, f)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::model::test_schema::*;

    #[test]
    fn joins_texts_and_drops_empty() {
        let s = schema();
        let f = Fragment::from(vec![
            t(&s, "a"),
            t(&s, ""),
            t(&s, "b"),
            tm(&s, "c", &["em"]),
        ]);
        assert_eq!(f.child_count(), 2);
        assert_eq!(f.size(), 3);
        assert_eq!(f.child(0).text(), Some("ab"));
        let g = f.append(&Fragment::from(tm(&s, "d", &["em"])));
        assert_eq!(g.child_count(), 2);
        assert_eq!(g.child(1).text(), Some("cd"));
    }

    #[test]
    fn cut_and_find_index() {
        let s = schema();
        let f = Fragment::from(vec![
            p(&s, vec![t(&s, "hello")]),
            p(&s, vec![t(&s, "world")]),
        ]);
        assert_eq!(f.size(), 14);
        assert_eq!(f.find_index(0, -1), (0, 0));
        assert_eq!(f.find_index(3, -1), (0, 0));
        assert_eq!(f.find_index(3, 1), (1, 7));
        assert_eq!(f.find_index(7, -1), (1, 7));
        assert_eq!(f.find_index(14, -1), (2, 14));
        let c = f.cut(3, 10);
        assert_eq!(c.to_string(), "<paragraph(\"llo\"), paragraph(\"wo\")>");
        assert_eq!(c.size(), 9);
        assert_eq!(f.cut(0, 14), f);
        assert_eq!(f.text_between(0, 14, Some("\n"), None), "hello\nworld");
        assert_eq!(f.text_between(3, 10, Some("|"), None), "llo|wo");
    }

    #[test]
    fn utf16_cut() {
        let s = schema();
        let f = Fragment::from(t(&s, "a😀中"));
        assert_eq!(f.size(), 4);
        assert_eq!(f.cut(1, 3).child(0).text(), Some("😀"));
        assert_eq!(f.cut(3, 4).child(0).text(), Some("中"));
        assert_eq!(f.text_between(1, 4, None, None), "😀中");
    }

    #[test]
    fn diff_start() {
        let s = schema();
        let a = Fragment::from(vec![p(&s, vec![t(&s, "abc")]), p(&s, vec![t(&s, "x")])]);
        let b = Fragment::from(vec![p(&s, vec![t(&s, "abd")]), p(&s, vec![t(&s, "x")])]);
        assert_eq!(a.find_diff_start(&b, 0), Some(3));
        assert_eq!(a.find_diff_start(&a.clone(), 0), None);
    }

    #[test]
    fn nodes_between_positions() {
        let s = schema();
        let d = doc(&s, vec![p(&s, vec![t(&s, "ab")]), p(&s, vec![t(&s, "cd")])]);
        let mut seen = Vec::new();
        d.nodes_between(2, 6, &mut |node, pos, parent, index| {
            seen.push((
                node.ty().name().to_owned(),
                pos,
                parent.map(|p| p.ty().name().to_owned()),
                index,
            ));
            true
        });
        assert_eq!(
            seen,
            vec![
                ("paragraph".into(), 0, Some("doc".into()), 0),
                ("text".into(), 1, Some("paragraph".into()), 0),
                ("paragraph".into(), 4, Some("doc".into()), 1),
                ("text".into(), 5, Some("paragraph".into()), 0),
            ]
        );
    }
}
