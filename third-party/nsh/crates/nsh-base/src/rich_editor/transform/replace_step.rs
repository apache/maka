//! Replacing a range with a slice, and replacing around a kept range
//! (prosemirror-transform's `replace_step.ts`).

use std::any::Any;

use serde_json::{Value, json};

use super::{
    map::{Mappable, StepMap},
    step::{BoxStep, Step, StepError, StepResult, from_replace, json_slice, json_usize},
};
use crate::rich_editor::model::{Node, Schema, Slice};

/// Replaces `from..to` with a slice whose open sides fit the document
/// around the range.
#[derive(Clone, Debug)]
pub struct ReplaceStep {
    /// The start of the replaced range.
    pub from: usize,
    /// The end of the replaced range.
    pub to: usize,
    /// The content put in its place.
    pub slice: Slice,
    /// Fails when the range holds more than closing and opening tokens,
    /// so a rebased structural step never overwrites content.
    pub structure: bool,
}

impl ReplaceStep {
    /// A replace step.
    pub fn new(from: usize, to: usize, slice: Slice, structure: bool) -> Self {
        Self {
            from,
            to,
            slice,
            structure,
        }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "from")?,
            json_usize(json, "to")?,
            json_slice(schema, json)?,
            json.get("structure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ))
    }
}

impl Step for ReplaceStep {
    fn apply(&self, doc: &Node) -> StepResult {
        if self.structure && content_between(doc, self.from, self.to)? {
            return Err(StepError::Apply(
                "structure replace would overwrite content".into(),
            ));
        }
        from_replace(doc, self.from, self.to, &self.slice)
    }

    fn get_map(&self) -> StepMap {
        StepMap::new(
            vec![self.from, self.to - self.from, self.slice.size()],
            false,
        )
    }

    fn invert(&self, before: &Node) -> BoxStep {
        Box::new(ReplaceStep::new(
            self.from,
            self.from + self.slice.size(),
            before
                .slice(self.from, self.to, false)
                .unwrap_or_else(|_| Slice::empty()),
            false,
        ))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let to = mapping.map_result(self.to, -1);
        let from = mapping.map_result(self.from, 1);
        if from.deleted_across && to.deleted_across {
            return None;
        }
        Some(Box::new(ReplaceStep::new(
            from.pos,
            from.pos.max(to.pos),
            self.slice.clone(),
            self.structure,
        )))
    }

    fn merge(&self, other: &dyn Step) -> Option<BoxStep> {
        let other = other.as_any().downcast_ref::<ReplaceStep>()?;
        if other.structure || self.structure {
            return None;
        }
        let join = |a: &Slice, b: &Slice| {
            if a.size() + b.size() == 0 {
                Slice::empty()
            } else {
                Slice {
                    content: a.content.append(&b.content),
                    open_start: a.open_start,
                    open_end: b.open_end,
                }
            }
        };
        if self.from + self.slice.size() == other.from
            && self.slice.open_end == 0
            && other.slice.open_start == 0
        {
            let slice = join(&self.slice, &other.slice);
            Some(Box::new(ReplaceStep::new(
                self.from,
                self.to + (other.to - other.from),
                slice,
                self.structure,
            )))
        } else if other.to == self.from && self.slice.open_start == 0 && other.slice.open_end == 0 {
            let slice = join(&other.slice, &self.slice);
            Some(Box::new(ReplaceStep::new(
                other.from,
                self.to,
                slice,
                self.structure,
            )))
        } else {
            None
        }
    }

    fn to_json(&self) -> Value {
        let mut json = json!({"stepType": "replace", "from": self.from, "to": self.to});
        if self.slice.size() > 0 {
            json["slice"] = self.slice.to_json();
        }
        if self.structure {
            json["structure"] = Value::Bool(true);
        }
        json
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Replaces `from..to` with a slice, moving the kept range
/// `gap_from..gap_to` into the slice at `insert`.
#[derive(Clone, Debug)]
pub struct ReplaceAroundStep {
    /// The start of the replaced range.
    pub from: usize,
    /// The end of the replaced range.
    pub to: usize,
    /// The start of the kept range.
    pub gap_from: usize,
    /// The end of the kept range.
    pub gap_to: usize,
    /// The content put in place of the range.
    pub slice: Slice,
    /// Where in the slice the kept range goes.
    pub insert: usize,
    /// As [`ReplaceStep::structure`].
    pub structure: bool,
}

impl ReplaceAroundStep {
    /// A replace-around step.
    pub fn new(
        from: usize,
        to: usize,
        gap_from: usize,
        gap_to: usize,
        slice: Slice,
        insert: usize,
        structure: bool,
    ) -> Self {
        Self {
            from,
            to,
            gap_from,
            gap_to,
            slice,
            insert,
            structure,
        }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "from")?,
            json_usize(json, "to")?,
            json_usize(json, "gapFrom")?,
            json_usize(json, "gapTo")?,
            json_slice(schema, json)?,
            json_usize(json, "insert")?,
            json.get("structure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ))
    }
}

impl Step for ReplaceAroundStep {
    fn apply(&self, doc: &Node) -> StepResult {
        if self.structure
            && (content_between(doc, self.from, self.gap_from)?
                || content_between(doc, self.gap_to, self.to)?)
        {
            return Err(StepError::Apply(
                "structure gap-replace would overwrite content".into(),
            ));
        }
        if self.gap_from > self.gap_to || self.gap_to > doc.content().size() {
            return Err(StepError::Apply("gap out of range".into()));
        }
        let gap = doc
            .slice(self.gap_from, self.gap_to, false)
            .map_err(|e| StepError::Apply(e.to_string()))?;
        if gap.open_start != 0 || gap.open_end != 0 {
            return Err(StepError::Apply("gap is not a flat range".into()));
        }
        let inserted = self
            .slice
            .insert_at(self.insert, &gap.content)
            .ok_or_else(|| StepError::Apply("content does not fit in gap".into()))?;
        from_replace(doc, self.from, self.to, &inserted)
    }

    fn get_map(&self) -> StepMap {
        StepMap::new(
            vec![
                self.from,
                self.gap_from - self.from,
                self.insert,
                self.gap_to,
                self.to - self.gap_to,
                self.slice.size() - self.insert,
            ],
            false,
        )
    }

    fn invert(&self, before: &Node) -> BoxStep {
        let gap = self.gap_to - self.gap_from;
        Box::new(ReplaceAroundStep::new(
            self.from,
            self.from + self.slice.size() + gap,
            self.from + self.insert,
            self.from + self.insert + gap,
            before
                .slice(self.from, self.to, false)
                .unwrap_or_else(|_| Slice::empty())
                .remove_between(self.gap_from - self.from, self.gap_to - self.from)
                .unwrap_or_else(|_| Slice::empty()),
            self.gap_from - self.from,
            self.structure,
        ))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let from = mapping.map_result(self.from, 1);
        let to = mapping.map_result(self.to, -1);
        let gap_from = if self.from == self.gap_from {
            from.pos
        } else {
            mapping.map(self.gap_from, -1)
        };
        let gap_to = if self.to == self.gap_to {
            to.pos
        } else {
            mapping.map(self.gap_to, 1)
        };
        if (from.deleted_across && to.deleted_across) || gap_from < from.pos || gap_to > to.pos {
            return None;
        }
        Some(Box::new(ReplaceAroundStep::new(
            from.pos,
            to.pos,
            gap_from,
            gap_to,
            self.slice.clone(),
            self.insert,
            self.structure,
        )))
    }

    fn to_json(&self) -> Value {
        let mut json = json!({
            "stepType": "replaceAround",
            "from": self.from,
            "to": self.to,
            "gapFrom": self.gap_from,
            "gapTo": self.gap_to,
            "insert": self.insert,
        });
        if self.slice.size() > 0 {
            json["slice"] = self.slice.to_json();
        }
        if self.structure {
            json["structure"] = Value::Bool(true);
        }
        json
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Whether `from..to` holds anything besides closing then opening tokens.
fn content_between(doc: &Node, from: usize, to: usize) -> Result<bool, StepError> {
    if to < from {
        return Err(StepError::Apply("inverted range".into()));
    }
    let rp = doc
        .resolve(from)
        .map_err(|e| StepError::Apply(e.to_string()))?;
    let mut dist = to - from;
    let mut depth = rp.depth;
    while dist > 0 && depth > 0 && rp.index_after(depth) == rp.node(depth).child_count() {
        depth -= 1;
        dist -= 1;
    }
    if dist > 0 {
        let mut next = rp.node(depth).maybe_child(rp.index_after(depth)).cloned();
        while dist > 0 {
            match next {
                Some(n) if !n.is_leaf() => next = n.first_child().cloned(),
                _ => return Ok(true),
            }
            dist -= 1;
        }
    }
    Ok(false)
}
