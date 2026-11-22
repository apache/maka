//! Adding and removing marks on inline content and on single nodes
//! (prosemirror-transform's `mark_step.ts`).

use std::any::Any;

use serde_json::{Value, json};

use super::{
    map::Mappable,
    step::{BoxStep, Step, StepError, StepResult, from_replace, json_mark, json_usize},
};
use crate::rich_editor::model::{Fragment, Mark, Node, Schema, Slice};

/// Rebuilds `fragment` with `f` applied to every inline node, depth first.
fn map_fragment(fragment: &Fragment, f: &dyn Fn(&Node, &Node) -> Node, parent: &Node) -> Fragment {
    let mut mapped = Vec::with_capacity(fragment.child_count());
    for i in 0..fragment.child_count() {
        let mut child: Node = fragment.child(i).clone();
        if child.content().size() > 0 {
            let content = map_fragment(child.content(), f, &child);
            child = child.copy(content);
        }
        if child.is_inline() {
            child = f(&child, parent);
        }
        mapped.push(child);
    }
    Fragment::from(mapped)
}

/// Rewrites the node at `pos` with new marks, keeping its content.
fn replace_node_marks(
    doc: &Node,
    pos: usize,
    marks: impl FnOnce(&[Mark]) -> Vec<Mark>,
) -> StepResult {
    let node = doc
        .node_at(pos)
        .ok_or_else(|| StepError::Apply("no node at mark step's position".into()))?;
    let updated = node.mark(marks(node.marks()));
    // A non-leaf node is replaced by its opening token only (open end), so
    // its content stays where it is.
    let slice = Slice {
        content: Fragment::from(vec![updated.copy(Fragment::empty())]),
        open_start: 0,
        open_end: if node.is_leaf() { 0 } else { 1 },
    };
    from_replace(doc, pos, pos + 1, &slice)
}

/// Adds a mark to all inline content between two positions.
#[derive(Clone, Debug)]
pub struct AddMarkStep {
    /// The start of the range.
    pub from: usize,
    /// The end of the range.
    pub to: usize,
    /// The mark to add.
    pub mark: Mark,
}

impl AddMarkStep {
    /// An add-mark step.
    pub fn new(from: usize, to: usize, mark: Mark) -> Self {
        Self { from, to, mark }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "from")?,
            json_usize(json, "to")?,
            json_mark(schema, json)?,
        ))
    }
}

impl Step for AddMarkStep {
    fn apply(&self, doc: &Node) -> StepResult {
        if self.from > self.to || self.to > doc.content().size() {
            return Err(StepError::Apply("mark range out of the document".into()));
        }
        let old = doc
            .slice(self.from, self.to, false)
            .map_err(|e| StepError::Apply(e.to_string()))?;
        let rp = doc
            .resolve(self.from)
            .map_err(|e| StepError::Apply(e.to_string()))?;
        let parent = rp.node(rp.shared_depth(self.to)).clone();
        let mark = &self.mark;
        let content = map_fragment(
            &old.content,
            &|node, parent| {
                if !node.is_atom() || !parent.ty().allows_mark_type(&mark.ty) {
                    return node.clone();
                }
                node.mark(mark.add_to_set(node.marks()))
            },
            &parent,
        );
        let slice = Slice {
            content,
            open_start: old.open_start,
            open_end: old.open_end,
        };
        from_replace(doc, self.from, self.to, &slice)
    }

    fn invert(&self, _before: &Node) -> BoxStep {
        Box::new(RemoveMarkStep::new(self.from, self.to, self.mark.clone()))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let from = mapping.map_result(self.from, 1);
        let to = mapping.map_result(self.to, -1);
        if (from.deleted && to.deleted) || from.pos >= to.pos {
            return None;
        }
        Some(Box::new(AddMarkStep::new(
            from.pos,
            to.pos,
            self.mark.clone(),
        )))
    }

    fn merge(&self, other: &dyn Step) -> Option<BoxStep> {
        let other = other.as_any().downcast_ref::<AddMarkStep>()?;
        (other.mark == self.mark && self.from <= other.to && self.to >= other.from).then(|| {
            Box::new(AddMarkStep::new(
                self.from.min(other.from),
                self.to.max(other.to),
                self.mark.clone(),
            )) as BoxStep
        })
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "addMark", "mark": self.mark.to_json(), "from": self.from, "to": self.to})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Removes a mark from all inline content between two positions.
#[derive(Clone, Debug)]
pub struct RemoveMarkStep {
    /// The start of the range.
    pub from: usize,
    /// The end of the range.
    pub to: usize,
    /// The mark to remove.
    pub mark: Mark,
}

impl RemoveMarkStep {
    /// A remove-mark step.
    pub fn new(from: usize, to: usize, mark: Mark) -> Self {
        Self { from, to, mark }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "from")?,
            json_usize(json, "to")?,
            json_mark(schema, json)?,
        ))
    }
}

impl Step for RemoveMarkStep {
    fn apply(&self, doc: &Node) -> StepResult {
        if self.from > self.to || self.to > doc.content().size() {
            return Err(StepError::Apply("mark range out of the document".into()));
        }
        let old = doc
            .slice(self.from, self.to, false)
            .map_err(|e| StepError::Apply(e.to_string()))?;
        let mark = &self.mark;
        let content = map_fragment(
            &old.content,
            &|node, _| node.mark(mark.remove_from_set(node.marks())),
            doc,
        );
        let slice = Slice {
            content,
            open_start: old.open_start,
            open_end: old.open_end,
        };
        from_replace(doc, self.from, self.to, &slice)
    }

    fn invert(&self, _before: &Node) -> BoxStep {
        Box::new(AddMarkStep::new(self.from, self.to, self.mark.clone()))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let from = mapping.map_result(self.from, 1);
        let to = mapping.map_result(self.to, -1);
        if (from.deleted && to.deleted) || from.pos >= to.pos {
            return None;
        }
        Some(Box::new(RemoveMarkStep::new(
            from.pos,
            to.pos,
            self.mark.clone(),
        )))
    }

    fn merge(&self, other: &dyn Step) -> Option<BoxStep> {
        let other = other.as_any().downcast_ref::<RemoveMarkStep>()?;
        (other.mark == self.mark && self.from <= other.to && self.to >= other.from).then(|| {
            Box::new(RemoveMarkStep::new(
                self.from.min(other.from),
                self.to.max(other.to),
                self.mark.clone(),
            )) as BoxStep
        })
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "removeMark", "mark": self.mark.to_json(), "from": self.from, "to": self.to})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Adds a mark to the node at a position.
#[derive(Clone, Debug)]
pub struct AddNodeMarkStep {
    /// The position before the node.
    pub pos: usize,
    /// The mark to add.
    pub mark: Mark,
}

impl AddNodeMarkStep {
    /// An add-node-mark step.
    pub fn new(pos: usize, mark: Mark) -> Self {
        Self { pos, mark }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "pos")?,
            json_mark(schema, json)?,
        ))
    }
}

impl Step for AddNodeMarkStep {
    fn apply(&self, doc: &Node) -> StepResult {
        replace_node_marks(doc, self.pos, |marks| self.mark.add_to_set(marks))
    }

    fn invert(&self, before: &Node) -> BoxStep {
        if let Some(node) = before.node_at(self.pos) {
            let new_set = self.mark.add_to_set(node.marks());
            // Adding replaced an exclusive mark: the inverse adds it back.
            if new_set.len() == node.marks().len() {
                for m in node.marks() {
                    if !m.is_in_set(&new_set) {
                        return Box::new(AddNodeMarkStep::new(self.pos, m.clone()));
                    }
                }
                return Box::new(AddNodeMarkStep::new(self.pos, self.mark.clone()));
            }
        }
        Box::new(RemoveNodeMarkStep::new(self.pos, self.mark.clone()))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let pos = mapping.map_result(self.pos, 1);
        (!pos.deleted_after)
            .then(|| Box::new(AddNodeMarkStep::new(pos.pos, self.mark.clone())) as BoxStep)
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "addNodeMark", "pos": self.pos, "mark": self.mark.to_json()})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Removes a mark from the node at a position.
#[derive(Clone, Debug)]
pub struct RemoveNodeMarkStep {
    /// The position before the node.
    pub pos: usize,
    /// The mark to remove.
    pub mark: Mark,
}

impl RemoveNodeMarkStep {
    /// A remove-node-mark step.
    pub fn new(pos: usize, mark: Mark) -> Self {
        Self { pos, mark }
    }

    pub(crate) fn from_json(schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "pos")?,
            json_mark(schema, json)?,
        ))
    }
}

impl Step for RemoveNodeMarkStep {
    fn apply(&self, doc: &Node) -> StepResult {
        replace_node_marks(doc, self.pos, |marks| self.mark.remove_from_set(marks))
    }

    fn invert(&self, before: &Node) -> BoxStep {
        match before.node_at(self.pos) {
            Some(node) if self.mark.is_in_set(node.marks()) => {
                Box::new(AddNodeMarkStep::new(self.pos, self.mark.clone()))
            }
            _ => Box::new(self.clone()),
        }
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let pos = mapping.map_result(self.pos, 1);
        (!pos.deleted_after)
            .then(|| Box::new(RemoveNodeMarkStep::new(pos.pos, self.mark.clone())) as BoxStep)
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "removeNodeMark", "pos": self.pos, "mark": self.mark.to_json()})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}
