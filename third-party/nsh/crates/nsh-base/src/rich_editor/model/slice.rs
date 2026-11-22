//! Slices: pieces of a document, open on either side (`prosemirror-model`'s
//! `Slice` and its helpers in `replace.ts`).

use std::fmt;

use serde_json::{Map, Value};

use super::{Fragment, Node, ReplaceError, Schema, SchemaError};

/// A piece of a document: a fragment and how many levels of nodes are open
/// at its start and end (cut through rather than whole).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Slice {
    /// Its content.
    pub content: Fragment,
    /// The depth open at its start.
    pub open_start: usize,
    /// The depth open at its end.
    pub open_end: usize,
}

impl fmt::Display for Slice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}({},{})", self.content, self.open_start, self.open_end)
    }
}

impl Slice {
    /// A slice of `content` open as deep as given.
    pub fn new(content: Fragment, open_start: usize, open_end: usize) -> Slice {
        Slice {
            content,
            open_start,
            open_end,
        }
    }

    /// The empty slice.
    pub fn empty() -> Slice {
        Slice::default()
    }

    /// The size it adds when inserted.
    pub fn size(&self) -> usize {
        self.content
            .size()
            .saturating_sub(self.open_start + self.open_end)
    }

    /// The slice with `fragment` inserted at `pos` (in its own coordinates);
    /// none when the parent there does not accept it.
    pub fn insert_at(&self, pos: usize, fragment: &Fragment) -> Option<Slice> {
        let content = insert_into(&self.content, pos + self.open_start, fragment, None)?;
        Some(Slice::new(content, self.open_start, self.open_end))
    }

    /// The slice without `from..to` (in its own coordinates), which must be
    /// flat (not crossing node boundaries).
    pub fn remove_between(&self, from: usize, to: usize) -> Result<Slice, ReplaceError> {
        Ok(Slice::new(
            remove_range(&self.content, from + self.open_start, to + self.open_start)?,
            self.open_start,
            self.open_end,
        ))
    }

    /// `fragment` as a slice open as deep as its first and last descendants
    /// allow (stopping at isolating nodes unless `open_isolating`).
    pub fn max_open(fragment: Fragment, open_isolating: bool) -> Slice {
        let mut open_start = 0;
        let mut n = fragment.first_child().cloned();
        while let Some(node) = n {
            if node.is_leaf() || (!open_isolating && node.ty().spec().isolating) {
                break;
            }
            open_start += 1;
            n = node.first_child().cloned();
        }
        let mut open_end = 0;
        let mut n = fragment.last_child().cloned();
        while let Some(node) = n {
            if node.is_leaf() || (!open_isolating && node.ty().spec().isolating) {
                break;
            }
            open_end += 1;
            n = node.last_child().cloned();
        }
        Slice::new(fragment, open_start, open_end)
    }

    /// ProseMirror's JSON: `{content, openStart?, openEnd?}`, null when
    /// empty.
    pub fn to_json(&self) -> Value {
        if self.content.size() == 0 {
            return Value::Null;
        }
        let mut obj = Map::new();
        obj.insert("content".into(), self.content.to_json());
        if self.open_start > 0 {
            obj.insert("openStart".into(), self.open_start.into());
        }
        if self.open_end > 0 {
            obj.insert("openEnd".into(), self.open_end.into());
        }
        Value::Object(obj)
    }

    /// Reads ProseMirror's JSON (null is the empty slice).
    pub fn from_json(schema: &Schema, json: &Value) -> Result<Slice, SchemaError> {
        if json.is_null() {
            return Ok(Slice::empty());
        }
        let open = |key: &str| match json.get(key) {
            None | Some(Value::Null) => Ok(0),
            Some(v) => v
                .as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| SchemaError::Json("Invalid input for Slice.fromJSON".into())),
        };
        Ok(Slice::new(
            Fragment::from_json(schema, json.get("content").unwrap_or(&Value::Null))?,
            open("openStart")?,
            open("openEnd")?,
        ))
    }
}

fn remove_range(content: &Fragment, from: usize, to: usize) -> Result<Fragment, ReplaceError> {
    let (index, offset) = content.find_index(from, -1);
    let child = content.maybe_child(index);
    let (index_to, offset_to) = content.find_index(to, -1);
    if offset == from || child.is_some_and(Node::is_text) {
        if offset_to != to && !content.maybe_child(index_to).is_some_and(Node::is_text) {
            return Err(ReplaceError("Removing non-flat range".into()));
        }
        return Ok(content
            .cut(0, from)
            .append(&content.cut(to, content.size())));
    }
    let child = child.ok_or_else(|| ReplaceError("Removing non-flat range".into()))?;
    if index != index_to {
        return Err(ReplaceError("Removing non-flat range".into()));
    }
    Ok(content.replace_child(
        index,
        child.copy(remove_range(
            child.content(),
            from - offset - 1,
            to - offset - 1,
        )?),
    ))
}

fn insert_into(
    content: &Fragment,
    dist: usize,
    insert: &Fragment,
    parent: Option<&Node>,
) -> Option<Fragment> {
    let (index, offset) = content.find_index(dist, -1);
    let child = content.maybe_child(index);
    if offset == dist || child.is_some_and(Node::is_text) {
        if parent.is_some_and(|p| !p.can_replace(index, index, insert, 0, insert.child_count())) {
            return None;
        }
        return Some(
            content
                .cut(0, dist)
                .append(insert)
                .append(&content.cut(dist, content.size())),
        );
    }
    let child = child?;
    let inner = insert_into(child.content(), dist - offset - 1, insert, Some(child))?;
    Some(content.replace_child(index, child.copy(inner)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::model::test_schema::*;

    #[test]
    fn max_open_and_size() {
        let s = schema();
        let f = Fragment::from(vec![
            p(&s, vec![t(&s, "ab")]),
            n(&s, "horizontal_rule", vec![]),
        ]);
        let sl = Slice::max_open(f, true);
        assert_eq!((sl.open_start, sl.open_end), (1, 0));
        assert_eq!(sl.size(), 4 + 1 - 1);
    }

    #[test]
    fn insert_and_remove() {
        let s = schema();
        let sl = Slice::new(
            Fragment::from(vec![p(&s, vec![t(&s, "abc")]), p(&s, vec![t(&s, "de")])]),
            1,
            1,
        );
        let ins = sl.insert_at(1, &Fragment::from(t(&s, "X"))).unwrap();
        assert_eq!(
            ins.to_string(),
            "<paragraph(\"aXbc\"), paragraph(\"de\")>(1,1)"
        );
        let rem = sl.remove_between(0, 2).unwrap();
        assert_eq!(
            rem.to_string(),
            "<paragraph(\"c\"), paragraph(\"de\")>(1,1)"
        );
        assert!(sl.remove_between(2, 6).is_err(), "crosses paragraphs");
        // A paragraph does not fit inside a paragraph.
        assert!(sl.insert_at(1, &Fragment::from(p(&s, vec![]))).is_none());
    }

    #[test]
    fn json() {
        let s = schema();
        let sl = Slice::new(
            Fragment::from(vec![p(&s, vec![t(&s, "a")]), p(&s, vec![t(&s, "b")])]),
            1,
            1,
        );
        let j = sl.to_json();
        assert_eq!(j["openStart"], 1);
        assert_eq!(Slice::from_json(&s, &j).unwrap(), sl);
        assert_eq!(Slice::from_json(&s, &Value::Null).unwrap(), Slice::empty());
        assert_eq!(Slice::empty().to_json(), Value::Null);
    }
}
