//! Resolved positions: a position with the path of nodes to it
//! (`prosemirror-model`'s `resolvedpos.ts`), and node ranges.

use std::fmt;

use super::{Mark, Node};

/// A position outside the document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PosError {
    /// `pos` is past the end of content of size `size`.
    OutOfRange {
        /// The position.
        pos: usize,
        /// The size of the content it was resolved in.
        size: usize,
    },
}

impl fmt::Display for PosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfRange { pos, size } => write!(f, "Position {pos} out of range (0..={size})"),
        }
    }
}

impl std::error::Error for PosError {}

#[derive(Clone)]
struct Step {
    node: Node,
    index: usize,
    /// The offset where the child at `index` starts, in document positions.
    offset: usize,
}

/// A position resolved in a document: the nodes it is in, at each depth,
/// with its index and offsets there. Depths count from the document (0) to
/// the innermost node holding the position (`depth`).
#[derive(Clone)]
pub struct ResolvedPos {
    /// The position.
    pub pos: usize,
    /// The depth of its parent.
    pub depth: usize,
    /// Its offset in its parent's content.
    pub parent_offset: usize,
    path: Vec<Step>,
}

impl fmt::Debug for ResolvedPos {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s = String::new();
        for i in 1..=self.depth {
            if !s.is_empty() {
                s.push('/');
            }
            s.push_str(&format!(
                "{}_{}",
                self.node(i).ty().name(),
                self.index(i - 1)
            ));
        }
        write!(f, "{s}:{}", self.parent_offset)
    }
}

impl PartialEq for ResolvedPos {
    fn eq(&self, other: &Self) -> bool {
        self.pos == other.pos && self.doc() == other.doc()
    }
}

impl ResolvedPos {
    pub(crate) fn resolve(doc: &Node, pos: usize) -> Result<ResolvedPos, PosError> {
        let size = doc.content().size();
        if pos > size {
            return Err(PosError::OutOfRange { pos, size });
        }
        let mut path = Vec::new();
        let mut start = 0;
        let mut parent_offset = pos;
        let mut node = doc.clone();
        loop {
            let (index, offset) = node.content().find_index(parent_offset, -1);
            let rem = parent_offset - offset;
            path.push(Step {
                node: node.clone(),
                index,
                offset: start + offset,
            });
            if rem == 0 {
                break;
            }
            let child = node.child(index).clone();
            if child.is_text() {
                break;
            }
            parent_offset = rem - 1;
            start += offset + 1;
            node = child;
        }
        Ok(ResolvedPos {
            pos,
            depth: path.len() - 1,
            parent_offset,
            path,
        })
    }

    /// The node at `depth` (0 the document, `self.depth` the parent).
    pub fn node(&self, depth: usize) -> &Node {
        &self.path[depth].node
    }

    /// The parent node.
    pub fn parent(&self) -> &Node {
        self.node(self.depth)
    }

    /// The document.
    pub fn doc(&self) -> &Node {
        self.node(0)
    }

    /// The index of the position in the node at `depth`.
    pub fn index(&self, depth: usize) -> usize {
        self.path[depth].index
    }

    /// The index after the position in the node at `depth`: past the
    /// child it is in, or the index itself at the parent between children.
    pub fn index_after(&self, depth: usize) -> usize {
        self.index(depth) + usize::from(!(depth == self.depth && self.text_offset() == 0))
    }

    /// Where the content of the node at `depth` starts.
    pub fn start(&self, depth: usize) -> usize {
        if depth == 0 {
            0
        } else {
            self.path[depth - 1].offset + 1
        }
    }

    /// Where the content of the node at `depth` ends.
    pub fn end(&self, depth: usize) -> usize {
        self.start(depth) + self.node(depth).content().size()
    }

    /// The position before the node at `depth` (`depth` ≥ 1; `depth + 1`
    /// gives the position itself).
    pub fn before(&self, depth: usize) -> usize {
        assert!(depth > 0, "There is no position before the top-level node");
        if depth == self.depth + 1 {
            self.pos
        } else {
            self.path[depth - 1].offset
        }
    }

    /// The position after the node at `depth` (`depth` ≥ 1).
    pub fn after(&self, depth: usize) -> usize {
        assert!(depth > 0, "There is no position after the top-level node");
        if depth == self.depth + 1 {
            self.pos
        } else {
            self.path[depth - 1].offset + self.path[depth].node.node_size()
        }
    }

    /// The offset of the position in the text node it is in (0 between
    /// nodes).
    pub fn text_offset(&self) -> usize {
        self.pos - self.path[self.depth].offset
    }

    /// The node directly after the position (a text cut at it).
    pub fn node_after(&self) -> Option<Node> {
        let parent = self.parent();
        let index = self.index(self.depth);
        if index == parent.child_count() {
            return None;
        }
        let d_off = self.text_offset();
        let child = parent.child(index);
        Some(if d_off > 0 {
            child.cut(d_off, child.node_size())
        } else {
            child.clone()
        })
    }

    /// The node directly before the position (a text cut at it).
    pub fn node_before(&self) -> Option<Node> {
        let index = self.index(self.depth);
        let d_off = self.text_offset();
        if d_off > 0 {
            return Some(self.parent().child(index).cut(0, d_off));
        }
        if index == 0 {
            None
        } else {
            Some(self.parent().child(index - 1).clone())
        }
    }

    /// The position of the child `index` of the node at `depth`.
    pub fn pos_at_index(&self, index: usize, depth: usize) -> usize {
        let node = self.node(depth);
        let mut pos = self.start(depth);
        for i in 0..index {
            pos += node.child(i).node_size();
        }
        pos
    }

    /// The marks text inserted here gets: those of the text before (after
    /// at a parent's start), without non-inclusive marks that do not
    /// continue after.
    pub fn marks(&self) -> Vec<Mark> {
        let parent = self.parent();
        let index = self.index(self.depth);
        if parent.content().size() == 0 {
            return Vec::new();
        }
        if self.text_offset() > 0 {
            return parent.child(index).marks().to_vec();
        }
        let (main, other) = match index.checked_sub(1).and_then(|i| parent.maybe_child(i)) {
            Some(before) => (before, parent.maybe_child(index)),
            None => match parent.maybe_child(index) {
                Some(after) => (after, None),
                None => return Vec::new(),
            },
        };
        let mut marks = main.marks().to_vec();
        marks.retain(|m| m.ty.spec().inclusive || other.is_some_and(|o| m.is_in_set(o.marks())));
        marks
    }

    /// The marks of a range from here to `end` to keep after deleting it;
    /// none when there is no inline node after the position.
    pub fn marks_across(&self, end: &ResolvedPos) -> Option<Vec<Mark>> {
        let after = self.parent().maybe_child(self.index(self.depth))?;
        if !after.is_inline() {
            return None;
        }
        let next = end.parent().maybe_child(end.index(end.depth));
        let mut marks = after.marks().to_vec();
        marks.retain(|m| m.ty.spec().inclusive || next.is_some_and(|n| m.is_in_set(n.marks())));
        Some(marks)
    }

    /// The deepest depth whose node holds both this position and `pos`.
    pub fn shared_depth(&self, pos: usize) -> usize {
        (1..=self.depth)
            .rev()
            .find(|&d| self.start(d) <= pos && self.end(d) >= pos)
            .unwrap_or(0)
    }

    /// The range of blocks around this position and `other`, at the
    /// deepest depth where `pred` accepts the parent (any without one).
    pub fn block_range(
        &self,
        other: &ResolvedPos,
        pred: Option<&dyn Fn(&Node) -> bool>,
    ) -> Option<NodeRange> {
        if other.pos < self.pos {
            return other.block_range(self, pred);
        }
        let skip = usize::from(self.parent().inline_content() || self.pos == other.pos);
        let top = self.depth.checked_sub(skip)?;
        (0..=top).rev().find_map(|d| {
            (other.pos <= self.end(d) && pred.is_none_or(|p| p(self.node(d))))
                .then(|| NodeRange::new(self.clone(), other.clone(), d))
        })
    }

    /// Whether `other` has the same parent node.
    pub fn same_parent(&self, other: &ResolvedPos) -> bool {
        self.pos - self.parent_offset == other.pos - other.parent_offset
    }

    /// The greater of the two positions.
    pub fn max<'a>(&'a self, other: &'a ResolvedPos) -> &'a ResolvedPos {
        if other.pos > self.pos { other } else { self }
    }

    /// The smaller of the two positions.
    pub fn min<'a>(&'a self, other: &'a ResolvedPos) -> &'a ResolvedPos {
        if other.pos < self.pos { other } else { self }
    }
}

/// A flat range of content: the children of the node at `depth` between
/// two positions.
#[derive(Clone, Debug)]
pub struct NodeRange {
    /// Its start (it may be deeper than `depth`).
    pub from: ResolvedPos,
    /// Its end.
    pub to: ResolvedPos,
    /// The depth of the node it is the content of.
    pub depth: usize,
}

impl NodeRange {
    /// The range of the node at `depth`'s children around `from..to`.
    pub fn new(from: ResolvedPos, to: ResolvedPos, depth: usize) -> NodeRange {
        NodeRange { from, to, depth }
    }

    /// The position at its start.
    pub fn start(&self) -> usize {
        self.from.before(self.depth + 1)
    }

    /// The position at its end.
    pub fn end(&self) -> usize {
        self.to.after(self.depth + 1)
    }

    /// The node whose children it covers.
    pub fn parent(&self) -> &Node {
        self.from.node(self.depth)
    }

    /// The index of its first child.
    pub fn start_index(&self) -> usize {
        self.from.index(self.depth)
    }

    /// The index after its last child.
    pub fn end_index(&self) -> usize {
        self.to.index_after(self.depth)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::model::{Node, test_schema::*};

    fn quote(s: &crate::rich_editor::model::Schema, c: Vec<Node>) -> Node {
        n(s, "blockquote", c)
    }

    #[test]
    fn resolves() {
        let s = schema();
        // doc(p("ab"), blockquote(p(em("cd"), "ef")))
        let d = doc(
            &s,
            vec![
                p(&s, vec![t(&s, "ab")]),
                quote(&s, vec![p(&s, vec![tm(&s, "cd", &["em"]), t(&s, "ef")])]),
            ],
        );
        let r = d.resolve(0).unwrap();
        assert_eq!((r.depth, r.parent_offset, r.index(0)), (0, 0, 0));
        assert_eq!(r.node_after().unwrap().ty().name(), "paragraph");
        let r = d.resolve(2).unwrap();
        assert_eq!((r.depth, r.parent_offset, r.text_offset()), (1, 1, 1));
        assert_eq!(r.node_before().unwrap().text(), Some("a"));
        assert_eq!(r.node_after().unwrap().text(), Some("b"));
        assert_eq!(
            (r.start(1), r.end(1), r.before(1), r.after(1)),
            (1, 3, 0, 4)
        );
        let r = d.resolve(8).unwrap();
        assert_eq!(r.depth, 2);
        assert_eq!(r.parent().ty().name(), "paragraph");
        assert_eq!((r.index(0), r.index(1), r.index(2)), (1, 0, 1));
        assert_eq!(r.index_after(2), 1);
        assert_eq!(
            (r.start(2), r.before(2), r.after(2), r.after(1)),
            (6, 5, 11, 12)
        );
        assert_eq!(r.pos_at_index(1, 0), 4);
        assert_eq!(r.shared_depth(6), 2);
        assert_eq!(r.shared_depth(2), 0);
        assert!(d.resolve(13).is_err());
        assert_eq!(d.resolve(12).unwrap().depth, 0);
    }

    #[test]
    fn marks_at() {
        let s = schema();
        let mut href = crate::rich_editor::model::Attrs::new();
        href.insert("href".into(), serde_json::json!("u"));
        let link = s.mark("link", Some(href)).unwrap();
        let d = doc(
            &s,
            vec![p(
                &s,
                vec![tm(&s, "ab", &["em"]), s.text("cd", vec![link]), t(&s, "e")],
            )],
        );
        let names = |m: Vec<Mark>| m.iter().map(|m| m.ty.name().to_owned()).collect::<Vec<_>>();
        assert_eq!(
            names(d.resolve(1).unwrap().marks()),
            ["em"],
            "start takes the marks after"
        );
        assert_eq!(names(d.resolve(3).unwrap().marks()), ["em"]);
        assert_eq!(names(d.resolve(4).unwrap().marks()), ["link"]);
        assert!(
            d.resolve(5).unwrap().marks().is_empty(),
            "link is not inclusive"
        );
        let (a, b) = (d.resolve(3).unwrap(), d.resolve(5).unwrap());
        assert!(a.marks_across(&b).unwrap().is_empty());
    }

    #[test]
    fn utf16_positions() {
        let s = schema();
        let d = doc(&s, vec![p(&s, vec![t(&s, "😀中")])]);
        let r = d.resolve(3).unwrap();
        assert_eq!(r.text_offset(), 2);
        assert_eq!(r.node_before().unwrap().text(), Some("😀"));
        assert_eq!(r.node_after().unwrap().text(), Some("中"));
    }

    #[test]
    fn block_ranges() {
        let s = schema();
        let d = doc(
            &s,
            vec![quote(
                &s,
                vec![p(&s, vec![t(&s, "a")]), p(&s, vec![t(&s, "b")])],
            )],
        );
        let (a, b) = (d.resolve(2).unwrap(), d.resolve(5).unwrap());
        let r = a.block_range(&b, None).unwrap();
        assert_eq!(
            (r.depth, r.start(), r.end(), r.start_index(), r.end_index()),
            (1, 1, 7, 0, 2)
        );
        let only_doc = |n: &Node| n.ty().name() == "doc";
        let r = a.block_range(&b, Some(&only_doc)).unwrap();
        assert_eq!((r.depth, r.start(), r.end()), (0, 0, 8));
        assert!(a.same_parent(&d.resolve(3).unwrap()));
        assert!(!a.same_parent(&b));
        assert_eq!(a.max(&b).pos, 5);
    }
}
