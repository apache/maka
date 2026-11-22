//! The layout as JS sees it: [`DockAreaLayout`], its [`DockRegion`]s and
//! their [`DockNode`] trees, the values a `DockArea` takes (`layout`) and
//! reports (`onLayoutChange`), and their conversions from and to
//! [`PaneTree`]s.
//!
//! A [`DockNode`] mirrors a [`PaneNode`] with its id optional: a layout the
//! app writes leaves ids out, and converting it assigns them; a reported
//! layout carries every id, and passing it back keeps them, so a container
//! keeps its identity across the round trip through the app.

use std::collections::HashSet;

use nsh_core::{
    element::{JsHost, JsIn, JsKind, JsObject, JsOwned, JsValue, PropError, TsTypes},
    geometry::{Axis, Points},
};

use super::{
    dock_placement::Dock,
    layout::{
        DockLayout, NodeId, NodeKind, PaneNode, PaneRef, PaneTree, PanelId, RootKind, adopt_node_id,
    },
    state::{DockAreaState, DockPlacement, DockState},
    state_convert::{PanelBuilder, PanelSource},
};

/// One container of a layout, as JS writes and reads it: a split of nodes
/// side by side or stacked, or a tab group of panels
/// (`{ type: "split", ... } | { type: "tabs", ... }` in TS).
#[derive(Clone, Debug, PartialEq)]
pub enum DockNode {
    /// Children side by side (`"horizontal"`) or stacked (`"vertical"`).
    Split {
        /// Its stable id (`None`: assigned when the layout is installed).
        id: Option<NodeId>,
        /// The direction the children are laid out in.
        axis: Axis,
        /// The children, in order.
        children: Vec<DockNode>,
        /// Each child's slot along `axis` (`None`, or missing:
        /// unconstrained).
        sizes: Vec<Option<Points>>,
    },
    /// Panels shown one at a time, selected from a tab bar.
    Tabs {
        /// Its stable id (`None`: assigned when the layout is installed).
        id: Option<NodeId>,
        /// The panels' keys, in tab order.
        panels: Vec<PanelId>,
        /// The index of the displayed panel.
        active_index: usize,
    },
}

impl Default for DockNode {
    /// An empty horizontal split: an empty center.
    fn default() -> Self {
        DockNode::Split {
            id: None,
            axis: Axis::Horizontal,
            children: Vec::new(),
            sizes: Vec::new(),
        }
    }
}

impl DockNode {
    /// Its id, if it has one.
    pub fn id(&self) -> Option<NodeId> {
        match self {
            DockNode::Split { id, .. } | DockNode::Tabs { id, .. } => *id,
        }
    }

    fn walk(&self, f: &mut impl FnMut(&DockNode)) {
        f(self);
        if let DockNode::Split { children, .. } = self {
            for child in children {
                child.walk(f);
            }
        }
    }
}

impl From<&PaneNode> for DockNode {
    fn from(node: &PaneNode) -> Self {
        match node.kind() {
            PaneRef::Split {
                axis,
                children,
                sizes,
            } => DockNode::Split {
                id: Some(node.id()),
                axis,
                children: children.iter().map(DockNode::from).collect(),
                sizes: sizes.to_vec(),
            },
            PaneRef::Tabs { panels, active_ix } => DockNode::Tabs {
                id: Some(node.id()),
                panels: panels.to_vec(),
                active_index: active_ix,
            },
        }
    }
}

impl From<&PaneTree> for DockNode {
    fn from(tree: &PaneTree) -> Self {
        tree.to_node()
    }
}

/// A layout described in Rust, with its ids assigned.
impl From<DockLayout> for DockNode {
    fn from(layout: DockLayout) -> Self {
        PaneTree::from_layout(layout, RootKind::Any).to_node()
    }
}

/// What a conversion of several trees has already used: ids and panels
/// appear once in a dock area.
#[derive(Default)]
struct Seen {
    nodes: HashSet<NodeId>,
    panels: HashSet<PanelId>,
}

/// Takes every id `node` carries before any is allocated, so an id
/// allocated for a node without one never equals an id given later in the
/// same layout.
fn reserve_ids(node: &DockNode) {
    node.walk(&mut |node| {
        if let Some(id) = node.id() {
            adopt_node_id(id.as_u64());
        }
    });
}

impl PaneTree {
    /// The tree `node` describes, normalized: missing ids are assigned
    /// (and a repeated one replaced), a panel listed again is dropped,
    /// `sizes` is fitted to `children` (a size that is not a positive
    /// number is unconstrained), and a split root is forced when
    /// `root_kind` asks for one.
    pub fn from_node(node: &DockNode, root_kind: RootKind) -> Self {
        reserve_ids(node);
        Self::from_node_in(node, root_kind, &mut Seen::default())
    }

    fn from_node_in(node: &DockNode, root_kind: RootKind, seen: &mut Seen) -> Self {
        let mut tree = PaneTree::new(root_kind);
        let root = build_node(&mut tree, node, seen);
        tree.install_root(root);
        tree
    }

    /// The tree as JS sees it, every id included.
    pub fn to_node(&self) -> DockNode {
        DockNode::from(self.root())
    }
}

fn build_node(tree: &mut PaneTree, node: &DockNode, seen: &mut Seen) -> PaneNode {
    let id = match node.id() {
        Some(id) if seen.nodes.insert(id) => id,
        _ => {
            let id = tree.allocate_node_id();
            seen.nodes.insert(id);
            id
        }
    };
    match node {
        DockNode::Split {
            axis,
            children,
            sizes,
            ..
        } => {
            let children: Vec<PaneNode> = children
                .iter()
                .map(|child| build_node(tree, child, seen))
                .collect();
            let sizes = (0..children.len())
                .map(|ix| {
                    sizes
                        .get(ix)
                        .copied()
                        .flatten()
                        .filter(|size| size.is_finite() && *size > Points::ZERO)
                })
                .collect();
            PaneNode::new(
                id,
                NodeKind::Split {
                    axis: *axis,
                    children,
                    sizes,
                },
            )
        }
        DockNode::Tabs {
            panels,
            active_index,
            ..
        } => {
            let mut kept = Vec::with_capacity(panels.len());
            for panel in panels {
                if seen.panels.insert(panel.clone()) {
                    kept.push(panel.clone());
                } else {
                    log::warn!("dock layout: panel `{panel}` is listed more than once");
                }
            }
            PaneNode::new(
                id,
                NodeKind::Tabs {
                    panels: kept,
                    active_ix: *active_index,
                },
            )
        }
    }
}

/// One dock of a [`DockAreaLayout`]: its layout, size and state.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockRegion {
    /// Its layout.
    pub layout: DockNode,
    /// Its size across its edge, in points (default 200, never below 100).
    #[prop(skip_none)]
    pub size: Option<Points>,
    /// Whether it is open (default true).
    #[prop(skip_none)]
    pub open: Option<bool>,
    /// Whether dragging its edge below its minimum closes it (default true).
    #[prop(skip_none)]
    pub collapsible: Option<bool>,
}

impl DockRegion {
    /// A dock of `layout`, open and collapsible at the default size.
    pub fn new(layout: impl Into<DockNode>) -> Self {
        Self {
            layout: layout.into(),
            ..Default::default()
        }
    }

    /// The dock of `tree` in state `dock`, every field set.
    pub fn from_tree(tree: &PaneTree, dock: &Dock) -> Self {
        Self {
            layout: tree.to_node(),
            size: Some(dock.size()),
            open: Some(dock.is_open()),
            collapsible: Some(dock.is_collapsible()),
        }
    }

    /// Its layout as a tree (a dock's root is unconstrained).
    pub fn to_tree(&self) -> PaneTree {
        PaneTree::from_node(&self.layout, RootKind::Any)
    }

    /// Its state, defaults filled in.
    pub fn to_dock(&self) -> Dock {
        let mut dock = Dock::default();
        if let Some(size) = self.size.filter(|size| size.is_finite()) {
            dock.set_size(size);
        }
        dock.set_open(self.open.unwrap_or(true));
        dock.set_collapsible(self.collapsible.unwrap_or(true));
        dock
    }
}

/// A whole dock area's layout: the center and the docks on its edges, as
/// a `DockArea` takes it (`layout`) and reports it (`onLayoutChange`).
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockAreaLayout {
    /// The center's layout (its root is always a split).
    pub center: DockNode,
    /// The dock on the left edge.
    #[prop(skip_none)]
    pub left: Option<DockRegion>,
    /// The dock on the right edge.
    #[prop(skip_none)]
    pub right: Option<DockRegion>,
    /// The dock on the bottom edge.
    #[prop(skip_none)]
    pub bottom: Option<DockRegion>,
}

impl DockAreaLayout {
    /// A layout of `center` alone.
    pub fn new(center: impl Into<DockNode>) -> Self {
        Self {
            center: center.into(),
            ..Default::default()
        }
    }

    /// The layout with `region` as the dock at `placement` (`Center`
    /// replaces the center's layout with the region's).
    pub fn with_dock(mut self, placement: DockPlacement, region: DockRegion) -> Self {
        match placement {
            DockPlacement::Center => self.center = region.layout,
            DockPlacement::Left => self.left = Some(region),
            DockPlacement::Right => self.right = Some(region),
            DockPlacement::Bottom => self.bottom = Some(region),
        }
        self
    }

    /// The dock at `placement` (`None` for the center).
    pub fn dock(&self, placement: DockPlacement) -> Option<&DockRegion> {
        match placement {
            DockPlacement::Left => self.left.as_ref(),
            DockPlacement::Right => self.right.as_ref(),
            DockPlacement::Bottom => self.bottom.as_ref(),
            DockPlacement::Center => None,
        }
    }

    /// The center's and each dock's tree, as the area installs them: ids
    /// assigned and unique across the area, each panel in one place (the
    /// first: the center, then left, right, bottom), every tree normalized.
    pub fn to_trees(&self) -> (PaneTree, Vec<(DockPlacement, PaneTree, Dock)>) {
        reserve_ids(&self.center);
        for placement in DockPlacement::DOCKS {
            if let Some(region) = self.dock(placement) {
                reserve_ids(&region.layout);
            }
        }
        let mut seen = Seen::default();
        let center = PaneTree::from_node_in(&self.center, RootKind::Split, &mut seen);
        let docks = DockPlacement::DOCKS
            .into_iter()
            .filter_map(|placement| {
                let region = self.dock(placement)?;
                let tree = PaneTree::from_node_in(&region.layout, RootKind::Any, &mut seen);
                Some((placement, tree, region.to_dock()))
            })
            .collect();
        (center, docks)
    }

    /// The layout of the center's and docks' trees.
    pub fn from_trees<'a>(
        center: &PaneTree,
        docks: impl IntoIterator<Item = (DockPlacement, &'a PaneTree, &'a Dock)>,
    ) -> Self {
        let mut layout = Self::new(center.to_node());
        for (placement, tree, dock) in docks {
            if placement != DockPlacement::Center {
                layout = layout.with_dock(placement, DockRegion::from_tree(tree, dock));
            }
        }
        layout
    }

    /// The layout in canonical form ([`Self::to_trees`]'s, every id and
    /// dock field set): what an area reports for it.
    pub fn normalized(&self) -> Self {
        let (center, docks) = self.to_trees();
        Self::from_trees(
            &center,
            docks
                .iter()
                .map(|(placement, tree, dock)| (*placement, tree, dock)),
        )
    }

    /// The layout in the persisted format, each panel written by `source`.
    /// A dock's `collapsible` is not part of the format.
    pub fn to_state(&self, source: &dyn PanelSource) -> DockAreaState {
        let (center, docks) = self.to_trees();
        let mut state = DockAreaState {
            center: center.to_state(source),
            ..Default::default()
        };
        for (placement, tree, dock) in docks {
            let dock = Some(DockState::new(
                tree.to_state(source),
                placement,
                dock.size(),
                dock.is_open(),
            ));
            match placement {
                DockPlacement::Left => state.left_dock = dock,
                DockPlacement::Right => state.right_dock = dock,
                DockPlacement::Bottom => state.bottom_dock = dock,
                DockPlacement::Center => {}
            }
        }
        state
    }

    /// The layout of persisted `state`, each panel's key read by `builder`.
    /// Each dock is the one its field names (`left_dock` is the left dock);
    /// a panel read twice is kept in its first place.
    pub fn from_state(state: &DockAreaState, builder: &mut dyn PanelBuilder) -> Self {
        let mut layout =
            Self::new(PaneTree::from_state(&state.center, RootKind::Split, builder).to_node());
        for placement in DockPlacement::DOCKS {
            let Some(dock_state) = state.dock(placement) else {
                continue;
            };
            let tree = PaneTree::from_state(dock_state.panel(), RootKind::Any, builder);
            let mut dock = Dock::new(dock_state.size());
            dock.set_open(dock_state.open());
            layout = layout.with_dock(placement, DockRegion::from_tree(&tree, &dock));
        }
        layout.normalized()
    }
}

// --- JS ---------------------------------------------------------------------

/// How deep a [`DockNode`] from JS may nest: far beyond any real layout,
/// and a bound on the recursion that reads it.
const MAX_DEPTH: usize = 32;

/// `DockNode`'s declaration, its split's axis `{axis}` (`Axis`).
const DOCK_NODE: &str = "/** A node of a dock layout, by its `type`: a split of nodes side by side (`\"horizontal\"`) or stacked (`\"vertical\"`), each child's slot in `sizes` (points, `null` unconstrained); or a tab group of panels by key, `activeIndex` the displayed one. `id` is the node's stable id: assigned when missing, reported back with every layout. */
export type DockNode =
  | { type: \"split\"; id?: number; axis: {axis}; children: DockNode[]; sizes?: (number | null)[] }
  | { type: \"tabs\"; id?: number; panels: string[]; activeIndex?: number };";

impl JsValue for DockNode {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("DockNode", |types| {
            DOCK_NODE.replace("{axis}", &Axis::ts_type(types))
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        node_from_js(value, 0)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let owned = JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        let set = |key: &str, value: JsOwned<'a>| host.set_field(object, key, value.into_raw());
        match self {
            DockNode::Split {
                id,
                axis,
                children,
                sizes,
            } => {
                set("type", "split".to_owned().to_js(host)?)?;
                if let Some(id) = id {
                    set("id", id.as_u64().to_js(host)?)?;
                }
                set("axis", axis.to_js(host)?)?;
                set("children", children.to_js(host)?)?;
                set("sizes", sizes.to_js(host)?)?;
            }
            DockNode::Tabs {
                id,
                panels,
                active_index,
            } => {
                set("type", "tabs".to_owned().to_js(host)?)?;
                if let Some(id) = id {
                    set("id", id.as_u64().to_js(host)?)?;
                }
                set("panels", panels.to_js(host)?)?;
                set("activeIndex", active_index.to_js(host)?)?;
            }
        }
        Ok(owned)
    }
}

fn node_from_js(value: JsIn<'_>, depth: usize) -> Result<DockNode, PropError> {
    if depth > MAX_DEPTH {
        return Err(PropError(format!(
            "a DockNode nested deeper than {MAX_DEPTH}"
        )));
    }
    if value.kind() != JsKind::Object {
        return Err(value.expected("a DockNode"));
    }
    let id = optional::<u64>(value, "id")?.map(NodeId::from_u64);
    let kind: String = required(value, "type")?;
    match kind.as_str() {
        "split" => {
            let axis: Axis = required(value, "axis")?;
            let children = value.field("children")?;
            let children = children.get();
            let len = children.array_len()?.ok_or_else(|| {
                PropError(format!("`children`: {}", children.expected("an array")))
            })?;
            let mut nodes = Vec::with_capacity(len.min(64));
            for i in 0..len {
                let child = children.index(i)?;
                nodes.push(
                    node_from_js(child.get(), depth + 1)
                        .map_err(|e| PropError(format!("`children`: [{i}]: {e}")))?,
                );
            }
            Ok(DockNode::Split {
                id,
                axis,
                children: nodes,
                sizes: optional(value, "sizes")?.unwrap_or_default(),
            })
        }
        "tabs" => Ok(DockNode::Tabs {
            id,
            panels: required(value, "panels")?,
            active_index: optional(value, "activeIndex")?.unwrap_or(0),
        }),
        other => Err(PropError(format!(
            "`type`: expected \"split\" or \"tabs\", got {other:?}"
        ))),
    }
}

/// Field `key` of `value` (`None`: `undefined` or `null`).
fn optional<T: JsValue>(value: JsIn<'_>, key: &str) -> Result<Option<T>, PropError> {
    let field = value.field(key)?;
    let field = field.get();
    if field.is_nullish() {
        return Ok(None);
    }
    T::from_js(field)
        .map(Some)
        .map_err(|e| PropError(format!("`{key}`: {e}")))
}

fn required<T: JsValue>(value: JsIn<'_>, key: &str) -> Result<T, PropError> {
    optional(value, key)?.ok_or_else(|| PropError(format!("`{key}` is missing")))
}

#[cfg(test)]
mod tests;
