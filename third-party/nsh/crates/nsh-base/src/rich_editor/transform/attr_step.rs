//! Setting one attribute of a node or of the document
//! (prosemirror-transform's `attr_step.ts`).

use std::any::Any;

use serde_json::{Value, json};

use super::{
    map::Mappable,
    step::{BoxStep, Step, StepError, StepResult, from_replace, json_str, json_usize},
};
use crate::rich_editor::model::{Fragment, Node, Schema, Slice};

/// Sets an attribute of the node at a position.
#[derive(Clone, Debug)]
pub struct AttrStep {
    /// The position before the node.
    pub pos: usize,
    /// The attribute's name.
    pub attr: String,
    /// Its new value.
    pub value: Value,
}

impl AttrStep {
    /// An attribute step.
    pub fn new(pos: usize, attr: impl Into<String>, value: Value) -> Self {
        Self {
            pos,
            attr: attr.into(),
            value,
        }
    }

    pub(crate) fn from_json(_schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_usize(json, "pos")?,
            json_str(json, "attr")?,
            json.get("value").cloned().unwrap_or(Value::Null),
        ))
    }
}

impl Step for AttrStep {
    fn apply(&self, doc: &Node) -> StepResult {
        let node = doc
            .node_at(self.pos)
            .ok_or_else(|| StepError::Apply("no node at attribute step's position".into()))?;
        let mut attrs = node.attrs().clone();
        attrs.insert(self.attr.clone(), self.value.clone());
        let updated = node
            .ty()
            .create(Some(attrs), Fragment::empty(), node.marks().to_vec())
            .map_err(|e| StepError::Apply(e.to_string()))?;
        let slice = Slice {
            content: Fragment::from(vec![updated]),
            open_start: 0,
            open_end: if node.is_leaf() { 0 } else { 1 },
        };
        from_replace(doc, self.pos, self.pos + 1, &slice)
    }

    fn invert(&self, before: &Node) -> BoxStep {
        let old = before
            .node_at(self.pos)
            .and_then(|n| n.attrs().get(&self.attr).cloned())
            .unwrap_or(Value::Null);
        Box::new(AttrStep::new(self.pos, self.attr.clone(), old))
    }

    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep> {
        let pos = mapping.map_result(self.pos, 1);
        (!pos.deleted_after).then(|| {
            Box::new(AttrStep::new(
                pos.pos,
                self.attr.clone(),
                self.value.clone(),
            )) as BoxStep
        })
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "attr", "pos": self.pos, "attr": self.attr, "value": self.value})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}

/// Sets an attribute of the document node.
#[derive(Clone, Debug)]
pub struct DocAttrStep {
    /// The attribute's name.
    pub attr: String,
    /// Its new value.
    pub value: Value,
}

impl DocAttrStep {
    /// A document attribute step.
    pub fn new(attr: impl Into<String>, value: Value) -> Self {
        Self {
            attr: attr.into(),
            value,
        }
    }

    pub(crate) fn from_json(_schema: &Schema, json: &Value) -> Result<Self, StepError> {
        Ok(Self::new(
            json_str(json, "attr")?,
            json.get("value").cloned().unwrap_or(Value::Null),
        ))
    }
}

impl Step for DocAttrStep {
    fn apply(&self, doc: &Node) -> StepResult {
        let mut attrs = doc.attrs().clone();
        attrs.insert(self.attr.clone(), self.value.clone());
        doc.ty()
            .create(Some(attrs), doc.content().clone(), doc.marks().to_vec())
            .map_err(|e| StepError::Apply(e.to_string()))
    }

    fn invert(&self, before: &Node) -> BoxStep {
        Box::new(DocAttrStep::new(
            self.attr.clone(),
            before
                .attrs()
                .get(&self.attr)
                .cloned()
                .unwrap_or(Value::Null),
        ))
    }

    fn map(&self, _mapping: &dyn Mappable) -> Option<BoxStep> {
        Some(Box::new(self.clone()))
    }

    fn to_json(&self) -> Value {
        json!({"stepType": "docAttr", "attr": self.attr, "value": self.value})
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn boxed_clone(&self) -> BoxStep {
        Box::new(self.clone())
    }
}
