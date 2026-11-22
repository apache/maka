use std::{cmp::Ordering, fmt};

use nsh_core::{
    element::{JsHost, JsIn, JsOwned, JsValue, PropError, SharedString, TsTypes},
    geometry::{Axis, Points},
};

/// Stable container identity. Survives structural edits and normalization so
/// the `DockArea` does not tear down and rebuild what an edit never touched.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct NodeId(u64);

impl NodeId {
    pub(crate) fn from_u64(raw: u64) -> Self {
        Self(raw)
    }

    /// The id as a number (what JS sees as a node's `id`).
    pub fn as_u64(self) -> u64 {
        self.0
    }
}

/// Stable panel identity: the app's key for the panel (`"files"`,
/// `"editor:src/main.rs"`).
///
/// A panel is known to the layout only by this key. The app renders its
/// content from the key, so the content follows the panel across moves
/// between groups and regions. Keys are unique within a dock area.
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub struct PanelId(SharedString);

impl PanelId {
    /// The panel keyed `key`.
    pub fn new(key: impl Into<SharedString>) -> Self {
        Self(key.into())
    }

    /// The key.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// The key, shared.
    pub fn key(&self) -> &SharedString {
        &self.0
    }
}

impl PartialOrd for PanelId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PanelId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl fmt::Display for PanelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl AsRef<str> for PanelId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl From<&'static str> for PanelId {
    fn from(key: &'static str) -> Self {
        Self(SharedString::new_static(key))
    }
}

impl From<String> for PanelId {
    fn from(key: String) -> Self {
        Self(key.into())
    }
}

impl From<SharedString> for PanelId {
    fn from(key: SharedString) -> Self {
        Self(key)
    }
}

impl From<&PanelId> for PanelId {
    fn from(id: &PanelId) -> Self {
        id.clone()
    }
}

/// A panel's key, a string in JS.
impl JsValue for PanelId {
    fn ts_type(types: &mut TsTypes) -> String {
        SharedString::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        SharedString::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// The shape of one container. Private: every mutation goes through
/// [`PaneTree`] so normalization always runs.
///
/// [`PaneTree`]: super::PaneTree
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum NodeKind {
    Split {
        axis: Axis,
        children: Vec<PaneNode>,
        sizes: Vec<Option<Points>>,
    },
    Tabs {
        panels: Vec<PanelId>,
        active_ix: usize,
    },
}

/// Borrowed read-only projection of a node.
#[derive(Debug)]
pub enum PaneRef<'a> {
    /// Children side by side (`Horizontal`) or stacked (`Vertical`).
    Split {
        /// The direction the children are laid out in.
        axis: Axis,
        /// The children, in order.
        children: &'a [PaneNode],
        /// Each child's slot along `axis`; `None` is unconstrained.
        sizes: &'a [Option<Points>],
    },
    /// Panels shown one at a time, selected from a tab bar.
    Tabs {
        /// The panels, in tab order.
        panels: &'a [PanelId],
        /// The index of the displayed panel.
        active_ix: usize,
    },
}

/// One container of a [`PaneTree`](super::PaneTree): a split or a tab group.
#[derive(Clone, PartialEq, Debug)]
pub struct PaneNode {
    id: NodeId,
    kind: NodeKind,
}

impl PaneNode {
    pub(crate) fn new(id: NodeId, kind: NodeKind) -> Self {
        Self { id, kind }
    }

    /// Its stable id.
    pub fn id(&self) -> NodeId {
        self.id
    }

    /// What it is and holds.
    pub fn kind(&self) -> PaneRef<'_> {
        match &self.kind {
            NodeKind::Split {
                axis,
                children,
                sizes,
            } => PaneRef::Split {
                axis: *axis,
                children,
                sizes,
            },
            NodeKind::Tabs { panels, active_ix } => PaneRef::Tabs {
                panels,
                active_ix: *active_ix,
            },
        }
    }

    pub(crate) fn kind_mut(&mut self) -> &mut NodeKind {
        &mut self.kind
    }

    pub(crate) fn kind_ref(&self) -> &NodeKind {
        &self.kind
    }

    /// Depth-first pre-order walk over this node and its descendants.
    pub fn walk(&self, f: &mut impl FnMut(&PaneNode)) {
        f(self);
        if let NodeKind::Split { children, .. } = &self.kind {
            for child in children {
                child.walk(f);
            }
        }
    }
}
