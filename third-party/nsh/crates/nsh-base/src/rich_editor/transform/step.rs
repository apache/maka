//! The step trait, its errors and JSON dispatch (prosemirror-transform's
//! `step.ts`).

use std::{any::Any, fmt};

use serde_json::Value;

use super::{
    attr_step::{AttrStep, DocAttrStep},
    map::{Mappable, StepMap},
    mark_step::{AddMarkStep, AddNodeMarkStep, RemoveMarkStep, RemoveNodeMarkStep},
    replace_step::{ReplaceAroundStep, ReplaceStep},
};
use crate::rich_editor::model::{Node, Schema, Slice};

/// Why a step or a transform failed.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum StepError {
    /// The step does not apply to the document (ProseMirror's failed
    /// `StepResult`).
    Apply(String),
    /// The arguments of a transform method are invalid for the document
    /// (ProseMirror's `RangeError`s).
    Invalid(String),
    /// A step's JSON is malformed or names an unknown step type.
    Json(String),
}

impl fmt::Display for StepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Apply(m) => write!(f, "step failed: {m}"),
            Self::Invalid(m) => write!(f, "invalid transform: {m}"),
            Self::Json(m) => write!(f, "invalid step JSON: {m}"),
        }
    }
}

impl std::error::Error for StepError {}

/// The result of applying a step: the new document or why it failed.
pub type StepResult = Result<Node, StepError>;

/// A boxed step.
pub type BoxStep = Box<dyn Step>;

/// An atomic, invertible and mappable change to a document.
pub trait Step: Send + Sync + fmt::Debug {
    /// Applies the step to `doc`.
    fn apply(&self, doc: &Node) -> StepResult;
    /// The map from positions before the step to positions after it.
    fn get_map(&self) -> StepMap {
        StepMap::empty()
    }
    /// The step that undoes this one; `before` is the document this step
    /// was applied to.
    fn invert(&self, before: &Node) -> BoxStep;
    /// The step with its positions mapped, `None` when the mapping
    /// deleted what it changes.
    fn map(&self, mapping: &dyn Mappable) -> Option<BoxStep>;
    /// One step doing this one and then `other`, when they combine.
    fn merge(&self, _other: &dyn Step) -> Option<BoxStep> {
        None
    }
    /// The step as ProseMirror JSON (`stepType` and its fields).
    fn to_json(&self) -> Value;
    /// The step as `Any`, to downcast to its type.
    fn as_any(&self) -> &dyn Any;
    /// A boxed copy of the step.
    fn boxed_clone(&self) -> BoxStep;
}

impl Clone for BoxStep {
    fn clone(&self) -> Self {
        self.boxed_clone()
    }
}

/// Applies `Node::replace`, turning its error into a failed step.
pub(crate) fn from_replace(doc: &Node, from: usize, to: usize, slice: &Slice) -> StepResult {
    doc.replace(from, to, slice)
        .map_err(|e| StepError::Apply(e.to_string()))
}

pub(crate) fn json_usize(json: &Value, key: &str) -> Result<usize, StepError> {
    json.get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| StepError::Json(format!("missing or invalid `{key}`")))
}

pub(crate) fn json_str<'a>(json: &'a Value, key: &str) -> Result<&'a str, StepError> {
    json.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| StepError::Json(format!("missing or invalid `{key}`")))
}

pub(crate) fn json_slice(schema: &Schema, json: &Value) -> Result<Slice, StepError> {
    match json.get("slice") {
        None | Some(Value::Null) => Ok(Slice::empty()),
        Some(v) => Slice::from_json(schema, v).map_err(|e| StepError::Json(e.to_string())),
    }
}

pub(crate) fn json_mark(
    schema: &Schema,
    json: &Value,
) -> Result<crate::rich_editor::model::Mark, StepError> {
    let v = json
        .get("mark")
        .ok_or_else(|| StepError::Json("missing `mark`".into()))?;
    crate::rich_editor::model::Mark::from_json(schema, v)
        .map_err(|e| StepError::Json(e.to_string()))
}

/// Reads one step type from its JSON.
pub type StepFromJson = fn(&Schema, &Value) -> Result<BoxStep, StepError>;

/// The step types JSON can name, by `stepType` (ProseMirror's
/// `Step.jsonID`): the built-in ones, plus those a framework registers.
/// A registry is a value the app owns (no global table), so several
/// editors can know different custom steps.
#[derive(Clone)]
#[non_exhaustive]
pub struct StepRegistry {
    types: std::collections::BTreeMap<String, StepFromJson>,
}

impl fmt::Debug for StepRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_set().entries(self.types.keys()).finish()
    }
}

impl Default for StepRegistry {
    fn default() -> Self {
        let mut types = std::collections::BTreeMap::new();
        let builtins: [(&str, StepFromJson); 8] = [
            ("replace", |s, j| {
                Ok(Box::new(ReplaceStep::from_json(s, j)?))
            }),
            ("replaceAround", |s, j| {
                Ok(Box::new(ReplaceAroundStep::from_json(s, j)?))
            }),
            ("addMark", |s, j| {
                Ok(Box::new(AddMarkStep::from_json(s, j)?))
            }),
            ("removeMark", |s, j| {
                Ok(Box::new(RemoveMarkStep::from_json(s, j)?))
            }),
            ("addNodeMark", |s, j| {
                Ok(Box::new(AddNodeMarkStep::from_json(s, j)?))
            }),
            ("removeNodeMark", |s, j| {
                Ok(Box::new(RemoveNodeMarkStep::from_json(s, j)?))
            }),
            ("attr", |s, j| Ok(Box::new(AttrStep::from_json(s, j)?))),
            ("docAttr", |s, j| {
                Ok(Box::new(DocAttrStep::from_json(s, j)?))
            }),
        ];
        for (id, f) in builtins {
            types.insert(id.to_owned(), f);
        }
        Self { types }
    }
}

impl StepRegistry {
    /// A registry of the built-in step types.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a step type under its JSON id; a duplicate id is an
    /// error, as in ProseMirror.
    pub fn register(
        &mut self,
        id: impl Into<String>,
        from_json: StepFromJson,
    ) -> Result<(), StepError> {
        let id = id.into();
        if self.types.contains_key(&id) {
            return Err(StepError::Json(format!(
                "duplicate use of step JSON id `{id}`"
            )));
        }
        self.types.insert(id, from_json);
        Ok(())
    }

    /// Whether a step type is registered under `id`.
    pub fn contains(&self, id: &str) -> bool {
        self.types.contains_key(id)
    }

    /// Reads a step from its JSON, dispatching on `stepType`.
    pub fn from_json(&self, schema: &Schema, json: &Value) -> Result<BoxStep, StepError> {
        let ty = json
            .get("stepType")
            .and_then(Value::as_str)
            .ok_or_else(|| StepError::Json("missing `stepType`".into()))?;
        let f = self
            .types
            .get(ty)
            .ok_or_else(|| StepError::Json(format!("no step type `{ty}`")))?;
        f(schema, json)
    }
}

/// Reads a built-in step from its ProseMirror JSON (see [`StepRegistry`]
/// for custom steps).
pub fn step_from_json(schema: &Schema, json: &Value) -> Result<BoxStep, StepError> {
    StepRegistry::default().from_json(schema, json)
}
