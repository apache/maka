//! Marks: styling or metadata attached to inline content (emphasis, links).
//! Mark sets are slices sorted by their types' ranks, at most one mark per
//! type unless a type does not exclude itself.

use std::fmt;

use serde_json::{Map, Value};

use super::{Attrs, MarkType, Schema, SchemaError};

/// A mark: a type and attributes.
#[derive(Clone, Debug)]
pub struct Mark {
    /// Its type.
    pub ty: MarkType,
    /// Its attributes.
    pub attrs: Attrs,
}

impl PartialEq for Mark {
    fn eq(&self, other: &Self) -> bool {
        self.ty == other.ty && self.attrs == other.attrs
    }
}

impl Eq for Mark {}

impl fmt::Display for Mark {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.ty.name())
    }
}

impl Mark {
    /// Its type.
    pub fn ty(&self) -> &MarkType {
        &self.ty
    }

    /// Its attributes.
    pub fn attrs(&self) -> &Attrs {
        &self.attrs
    }

    /// `set` with this mark added in rank order; marks it excludes are
    /// dropped, and `set` is returned unchanged when it holds the mark or one
    /// that excludes it.
    pub fn add_to_set(&self, set: &[Mark]) -> Vec<Mark> {
        let mut copy: Option<Vec<Mark>> = None;
        let mut placed = false;
        for (i, other) in set.iter().enumerate() {
            if self == other {
                return set.to_vec();
            }
            if self.ty.excludes(&other.ty) {
                copy.get_or_insert_with(|| set[..i].to_vec());
            } else if other.ty.excludes(&self.ty) {
                return set.to_vec();
            } else {
                if !placed && other.ty.rank() > self.ty.rank() {
                    copy.get_or_insert_with(|| set[..i].to_vec())
                        .push(self.clone());
                    placed = true;
                }
                if let Some(copy) = &mut copy {
                    copy.push(other.clone());
                }
            }
        }
        let mut copy = copy.unwrap_or_else(|| set.to_vec());
        if !placed {
            copy.push(self.clone());
        }
        copy
    }

    /// `set` without this mark.
    pub fn remove_from_set(&self, set: &[Mark]) -> Vec<Mark> {
        set.iter().filter(|m| *m != self).cloned().collect()
    }

    /// Whether `set` holds this mark.
    pub fn is_in_set(&self, set: &[Mark]) -> bool {
        set.iter().any(|m| m == self)
    }

    /// Whether two mark sets are the same.
    pub fn same_set(a: &[Mark], b: &[Mark]) -> bool {
        a == b
    }

    /// `marks` as a set: sorted by rank.
    pub fn set_from(mut marks: Vec<Mark>) -> Vec<Mark> {
        marks.sort_by_key(|m| m.ty.rank());
        marks
    }

    /// ProseMirror's JSON: `{type, attrs?}`.
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("type".into(), Value::String(self.ty.name().into()));
        if !self.attrs.is_empty() {
            obj.insert(
                "attrs".into(),
                Value::Object(self.attrs.clone().into_iter().collect()),
            );
        }
        Value::Object(obj)
    }

    /// Reads ProseMirror's JSON, checking the attributes.
    pub fn from_json(schema: &Schema, json: &Value) -> Result<Mark, SchemaError> {
        let name = json
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| SchemaError::Json("Invalid input for Mark.fromJSON".into()))?;
        let ty = schema.mark_type(name).ok_or_else(|| {
            SchemaError::Json(format!("There is no mark type {name} in this schema"))
        })?;
        let attrs = attrs_from_json(json.get("attrs"))?;
        let mark = ty.create(attrs)?;
        ty.check_attrs(&mark.attrs)?;
        Ok(mark)
    }
}

/// The marks of `marks` that carry on into a new block when a block is
/// split (their type's `keep_on_split`, Tiptap's `keepOnSplit`).
pub fn marks_kept_on_split(marks: &[Mark]) -> Vec<Mark> {
    marks
        .iter()
        .filter(|m| m.ty().spec().keep_on_split)
        .cloned()
        .collect()
}

pub(crate) fn attrs_from_json(value: Option<&Value>) -> Result<Option<Attrs>, SchemaError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map.clone().into_iter().collect())),
        Some(_) => Err(SchemaError::Json("attrs must be an object".into())),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rich_editor::model::{SchemaSpec, test_schema::schema};

    #[test]
    fn sets() {
        let s = schema();
        let em = s.mark("em", None).unwrap();
        let strong = s.mark("strong", None).unwrap();
        let code = s.mark("code", None).unwrap();
        let set = code.add_to_set(&[]);
        let set = em.add_to_set(&set);
        let set = strong.add_to_set(&set);
        let names: Vec<String> = set.iter().map(|m| m.to_string()).collect();
        assert_eq!(names, ["em", "strong", "code"]);
        assert_eq!(em.add_to_set(&set), set);
        assert!(strong.is_in_set(&set));
        let without = strong.remove_from_set(&set);
        assert_eq!(without.len(), 2);
        assert!(!strong.is_in_set(&without));
        assert!(s.mark_type("em").unwrap().is_in_set(&set).is_some());
    }

    #[test]
    fn exclusion_replaces() {
        let s = schema();
        let link = |h: &str| {
            let mut a = Attrs::new();
            a.insert("href".into(), json!(h));
            s.mark("link", Some(a)).unwrap()
        };
        let set = link("a").add_to_set(&[]);
        let set = link("b").add_to_set(&set);
        assert_eq!(set, vec![link("b")]);

        let s2 = SchemaSpec::from_json(&json!({
            "nodes": [["doc", {"content": "text*"}], ["text", {}]],
            "marks": [["a", {}], ["b", {"excludes": "a"}], ["c", {"excludes": ""}]]
        }))
        .unwrap();
        let m = |n| s2.mark(n, None).unwrap();
        let set = m("b").add_to_set(&m("a").add_to_set(&[]));
        assert_eq!(set, vec![m("b")]);
        // `a` cannot join a set holding `b`, which excludes it.
        assert_eq!(m("a").add_to_set(&set), set);
        let c = m("c");
        assert_eq!(
            c.add_to_set(&c.add_to_set(&[])).len(),
            1,
            "equal marks are not added twice"
        );
    }

    #[test]
    fn json() {
        let s = schema();
        let mark = Mark::from_json(&s, &json!({"type": "link", "attrs": {"href": "x"}})).unwrap();
        assert_eq!(
            mark.to_json(),
            json!({"type": "link", "attrs": {"href": "x"}})
        );
        assert!(Mark::from_json(&s, &json!({"type": "nope"})).is_err());
        assert!(Mark::from_json(&s, &json!({"type": "link"})).is_err());
    }
}
