//! The layout algebra: [`PaneTree`]s of splits and tab groups, edited and
//! normalized as plain values.

mod builder;
mod edit;
mod node;
mod normalize;
mod tree;

pub use builder::DockLayout;
pub use edit::{EditResult, InsertTarget};
// `NodeKind` stays crate-private: the conversions read and build through
// it, but nothing outside this crate may build a node without going
// through `PaneTree`, which is what guarantees normalization always runs.
pub(crate) use node::NodeKind;
pub use node::{NodeId, PaneNode, PaneRef, PanelId};
pub(crate) use tree::adopt_node_id;
pub use tree::{PaneTree, RootKind};
