//! Changes to documents, after prosemirror-transform: [`Step`]s are
//! atomic, invertible and mappable changes (replacing ranges, marks,
//! attributes); [`StepMap`]s and [`Mapping`]s carry positions across them
//! (with mirrors, for rebasing); a [`Transform`] applies steps one after
//! another, each all or nothing, and builds edits from them (fitting
//! slices, lifting, wrapping, splitting, joining, marks). Custom step
//! types plug in through [`Step`] and a [`StepRegistry`].

mod attr_step;
mod map;
mod mark_step;
mod replace;
mod replace_step;
mod step;
mod structure;
#[allow(clippy::module_inception)]
mod transform;

pub use attr_step::{AttrStep, DocAttrStep};
pub use map::{MapResult, Mappable, Mapping, StepMap};
pub use mark_step::{AddMarkStep, AddNodeMarkStep, RemoveMarkStep, RemoveNodeMarkStep};
pub use replace::replace_step;
pub use replace_step::{ReplaceAroundStep, ReplaceStep};
pub use step::{BoxStep, Step, StepError, StepFromJson, StepRegistry, StepResult, step_from_json};
pub use structure::{
    TypeAfter, can_join, can_split, drop_point, find_wrapping, insert_point, join_point,
    lift_target,
};
pub use transform::{MarkMatch, Transform};
