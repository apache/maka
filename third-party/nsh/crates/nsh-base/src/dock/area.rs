//! A whole dock area as one value: the center's tree and each dock's tree
//! and state, and the edits a `DockArea` makes to them, across trees.
//!
//! [`PaneTree`]'s edits work within one tree; an area holds up to four
//! (the center and a dock per edge), and a panel dragged from a dock into
//! the center leaves one tree for another. [`Area`] is where that happens,
//! as `gpui-base`'s `DockArea` does it: a move across trees is a detach
//! from the source and an insert into the destination, and a panel never
//! leaves the area on the way (it is not told it was removed). Every edit
//! returns whether it changed anything; the component reports the new
//! layout when it did. Like the trees, it is plain data, tested without an
//! engine.
//!
//! The rules a tab group's chrome follows are here too ([`Area::groups`]):
//! a group with nothing beside it in its tree and one visible panel cannot
//! give that panel away (dragging or closing it would empty the region),
//! and a locked or zoomed area rearranges nothing.

use std::collections::{HashMap, HashSet};

use nsh_core::{
    element::Placement,
    geometry::{Axis, Points},
};

use super::{
    dock_placement::Dock,
    layout::{InsertTarget, NodeId, PaneNode, PaneRef, PaneTree, PanelId, RootKind},
    state::DockPlacement,
    value::DockAreaLayout,
};

/// One dock of an [`Area`]: where it is, its layout and its state.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DockPane {
    pub(crate) placement: DockPlacement,
    pub(crate) tree: PaneTree,
    pub(crate) dock: Dock,
}

/// A dock area's layout as the component holds it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Area {
    pub(crate) center: PaneTree,
    /// The docks it has, in [`DockPlacement::DOCKS`]' order.
    pub(crate) docks: Vec<DockPane>,
}

impl Default for Area {
    fn default() -> Self {
        Self {
            center: PaneTree::new(RootKind::Split),
            docks: Vec::new(),
        }
    }
}

/// What a tab group's chrome may do, from its place in the area.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct GroupRules {
    /// Nothing sits beside it in its tree.
    pub(crate) alone: bool,
    /// Its tabs can be dragged out and closed (`gpui-base`'s
    /// `TabGroup::draggable`): not locked, and not the last visible panel
    /// of a group alone in its tree.
    pub(crate) draggable: bool,
    /// Panels can be dropped on it.
    pub(crate) droppable: bool,
}

/// A tab group of an area, as the views show it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Group {
    pub(crate) node: NodeId,
    pub(crate) placement: DockPlacement,
    pub(crate) panels: Vec<PanelId>,
    pub(crate) active_ix: usize,
    pub(crate) alone: bool,
}

impl Group {
    /// The displayed panel.
    pub(crate) fn active(&self) -> Option<&PanelId> {
        self.panels.get(self.active_ix)
    }
}

impl Area {
    /// The area `layout` describes, ids assigned and every tree normalized.
    pub(crate) fn from_layout(layout: &DockAreaLayout) -> Self {
        let (center, docks) = layout.to_trees();
        Self {
            center,
            docks: docks
                .into_iter()
                .map(|(placement, tree, dock)| DockPane {
                    placement,
                    tree,
                    dock,
                })
                .collect(),
        }
    }

    /// The layout as JS sees it.
    pub(crate) fn to_layout(&self) -> DockAreaLayout {
        DockAreaLayout::from_trees(
            &self.center,
            self.docks
                .iter()
                .map(|pane| (pane.placement, &pane.tree, &pane.dock)),
        )
    }

    pub(crate) fn dock(&self, placement: DockPlacement) -> Option<&DockPane> {
        self.docks.iter().find(|pane| pane.placement == placement)
    }

    fn dock_mut(&mut self, placement: DockPlacement) -> Option<&mut DockPane> {
        self.docks
            .iter_mut()
            .find(|pane| pane.placement == placement)
    }

    pub(crate) fn tree(&self, placement: DockPlacement) -> Option<&PaneTree> {
        match placement {
            DockPlacement::Center => Some(&self.center),
            _ => self.dock(placement).map(|pane| &pane.tree),
        }
    }

    fn tree_mut(&mut self, placement: DockPlacement) -> Option<&mut PaneTree> {
        match placement {
            DockPlacement::Center => Some(&mut self.center),
            _ => self.dock_mut(placement).map(|pane| &mut pane.tree),
        }
    }

    /// Every tree, the center first.
    fn trees(&self) -> impl Iterator<Item = (DockPlacement, &PaneTree)> {
        std::iter::once((DockPlacement::Center, &self.center))
            .chain(self.docks.iter().map(|pane| (pane.placement, &pane.tree)))
    }

    /// The region holding container `node`.
    pub(crate) fn placement_of_node(&self, node: NodeId) -> Option<DockPlacement> {
        self.trees()
            .find(|(_, tree)| tree.find_node(node).is_some())
            .map(|(placement, _)| placement)
    }

    /// The region holding `panel`.
    pub(crate) fn placement_of_panel(&self, panel: &str) -> Option<DockPlacement> {
        self.trees()
            .find(|(_, tree)| tree.contains_panel(panel))
            .map(|(placement, _)| placement)
    }

    /// Every panel, in tree order (the center first).
    pub(crate) fn panels(&self) -> Vec<PanelId> {
        self.trees().flat_map(|(_, tree)| tree.panels()).collect()
    }

    /// The tab group holding `panel`.
    pub(crate) fn group_of_panel(&self, panel: &str) -> Option<NodeId> {
        self.trees()
            .find_map(|(_, tree)| tree.find_panel_node(panel))
    }

    /// Every tab group, in tree order (the center first).
    pub(crate) fn groups(&self) -> Vec<Group> {
        let mut out = Vec::new();
        for (placement, tree) in self.trees() {
            collect_groups(tree.root(), placement, true, &mut out);
        }
        out
    }

    /// Tab group `node`.
    pub(crate) fn group(&self, node: NodeId) -> Option<Group> {
        self.groups().into_iter().find(|group| group.node == node)
    }

    /// What tab group `node`'s chrome may do: `visible` says which panels
    /// show, `locked` whether the area forbids rearranging.
    pub(crate) fn rules(
        &self,
        node: NodeId,
        locked: bool,
        visible: impl Fn(&PanelId) -> bool,
    ) -> GroupRules {
        let Some(group) = self.group(node) else {
            return GroupRules::default();
        };
        let shown = group.panels.iter().filter(|p| visible(p)).count();
        GroupRules {
            alone: group.alone,
            draggable: !locked && !(group.alone && shown <= 1),
            droppable: !locked,
        }
    }

    /// Adds `panel` to region `placement`, into its first tab group or a
    /// new one when the region has none (a dock is made for it, `size`
    /// across, when the area has none there). A panel the area holds
    /// already moves there instead.
    pub(crate) fn add_panel(
        &mut self,
        panel: PanelId,
        placement: DockPlacement,
        size: Option<Points>,
    ) -> bool {
        let created = placement != DockPlacement::Center && self.dock(placement).is_none();
        if created {
            let mut dock = Dock::default();
            if let Some(size) = size {
                dock.set_size(size);
            }
            let at = DockPlacement::DOCKS
                .iter()
                .position(|p| *p == placement)
                .unwrap_or(0);
            let index = self
                .docks
                .iter()
                .position(|pane| {
                    DockPlacement::DOCKS
                        .iter()
                        .position(|p| *p == pane.placement)
                        .unwrap_or(0)
                        > at
                })
                .unwrap_or(self.docks.len());
            self.docks.insert(
                index,
                DockPane {
                    placement,
                    tree: PaneTree::new(RootKind::Any),
                    dock,
                },
            );
        }
        let Some(tree) = self.tree(placement) else {
            return false;
        };
        let target = match first_tab_group(tree.root()) {
            Some(node) => InsertTarget::Tabs {
                node,
                ix: None,
                activate: true,
            },
            // An empty region has no group to merge into: the panel makes
            // one beside the root, which normalization then folds away.
            None => InsertTarget::Split {
                node: tree.root().id(),
                placement: Placement::Right,
                size: None,
            },
        };
        let changed = self.move_panel(panel, target);
        // A dock made for a panel that landed nowhere goes again.
        if created && !changed {
            self.docks.retain(|pane| pane.placement != placement);
        }
        changed
    }

    /// Removes `panel` wherever it is.
    pub(crate) fn remove_panel(&mut self, panel: &str) -> bool {
        let Some(placement) = self.placement_of_panel(panel) else {
            return false;
        };
        self.tree_mut(placement)
            .is_some_and(|tree| tree.remove_panel(panel).changed())
    }

    /// Moves `panel` to `target`, in its tree or another (a panel the area
    /// does not hold yet is added there). Across trees it is a detach and
    /// an insert, and both count: an insert the target cannot take leaves
    /// the panel where it was rather than nowhere.
    pub(crate) fn move_panel(&mut self, panel: PanelId, target: InsertTarget) -> bool {
        let Some(destination) = self.placement_of_node(target_node(&target)) else {
            return false;
        };
        match self.placement_of_panel(panel.as_str()) {
            Some(source) if source == destination => self
                .tree_mut(destination)
                .is_some_and(|tree| tree.move_panel(panel, target).changed()),
            source => {
                let before = self.clone();
                let detached = source
                    .and_then(|source| self.tree_mut(source))
                    .is_some_and(|tree| tree.remove_panel(panel.as_str()).changed());
                let inserted = self
                    .tree_mut(destination)
                    .is_some_and(|tree| tree.insert_panel(panel, target).changed());
                if detached && !inserted {
                    *self = before;
                    return false;
                }
                detached || inserted
            }
        }
    }

    /// Shows `panel` in the tab group holding it.
    pub(crate) fn select_panel(&mut self, panel: &str) -> bool {
        let Some(node) = self.group_of_panel(panel) else {
            return false;
        };
        let Some(ix) = self
            .group(node)
            .and_then(|group| group.panels.iter().position(|p| p.as_str() == panel))
        else {
            return false;
        };
        self.set_active(node, ix)
    }

    /// Shows tab `ix` of tab group `node`.
    pub(crate) fn set_active(&mut self, node: NodeId, ix: usize) -> bool {
        let Some(placement) = self.placement_of_node(node) else {
            return false;
        };
        self.tree_mut(placement)
            .is_some_and(|tree| tree.set_active(node, ix).changed())
    }

    /// Puts `panel` in a new tab group on the `side` of container `node`
    /// (moving it there when the area holds it).
    pub(crate) fn split_at(
        &mut self,
        node: NodeId,
        panel: PanelId,
        side: Placement,
        size: Option<Points>,
    ) -> bool {
        self.move_panel(
            panel,
            InsertTarget::Split {
                node,
                placement: side,
                size,
            },
        )
    }

    /// Sets the slot sizes of split `node`.
    pub(crate) fn set_split_sizes(&mut self, node: NodeId, sizes: Vec<Option<Points>>) -> bool {
        let Some(placement) = self.placement_of_node(node) else {
            return false;
        };
        self.tree_mut(placement)
            .is_some_and(|tree| tree.set_sizes(node, sizes).changed())
    }

    /// Opens or closes the dock at `placement`; a dock that is not
    /// collapsible refuses to close.
    pub(crate) fn set_dock_open(&mut self, placement: DockPlacement, open: bool) -> bool {
        let Some(pane) = self.dock_mut(placement) else {
            return false;
        };
        if pane.dock.is_open() == open || (!open && !pane.dock.is_collapsible()) {
            return false;
        }
        pane.dock.set_open(open);
        true
    }

    /// Sets the size of the dock at `placement` across its edge.
    pub(crate) fn set_dock_size(&mut self, placement: DockPlacement, size: Points) -> bool {
        let Some(pane) = self.dock_mut(placement) else {
            return false;
        };
        let before = pane.dock;
        pane.dock.set_size(size);
        pane.dock != before
    }

    /// Whether the dock at `placement` is open (a dock the area does not
    /// have never is).
    pub(crate) fn is_dock_open(&self, placement: DockPlacement) -> bool {
        self.dock(placement).is_some_and(|pane| pane.dock.is_open())
    }

    /// Which panels are displayed: each group's active one, but none of a
    /// closed dock's.
    pub(crate) fn displayed(&self) -> HashMap<PanelId, bool> {
        let mut out = HashMap::new();
        for group in self.groups() {
            let open =
                group.placement == DockPlacement::Center || self.is_dock_open(group.placement);
            for (ix, panel) in group.panels.iter().enumerate() {
                out.insert(panel.clone(), open && ix == group.active_ix);
            }
        }
        out
    }

    /// The panels in `self` that `next` no longer holds.
    pub(crate) fn removed_in(&self, next: &Area) -> Vec<PanelId> {
        let kept: HashSet<PanelId> = next.panels().into_iter().collect();
        self.panels()
            .into_iter()
            .filter(|panel| !kept.contains(panel))
            .collect()
    }
}

fn collect_groups(node: &PaneNode, placement: DockPlacement, alone: bool, out: &mut Vec<Group>) {
    match node.kind() {
        PaneRef::Split { children, .. } => {
            let alone = children.len() <= 1;
            for child in children {
                collect_groups(child, placement, alone, out);
            }
        }
        PaneRef::Tabs { panels, active_ix } => out.push(Group {
            node: node.id(),
            placement,
            panels: panels.to_vec(),
            active_ix,
            alone,
        }),
    }
}

fn first_tab_group(node: &PaneNode) -> Option<NodeId> {
    match node.kind() {
        PaneRef::Tabs { .. } => Some(node.id()),
        PaneRef::Split { children, .. } => children.iter().find_map(first_tab_group),
    }
}

fn target_node(target: &InsertTarget) -> NodeId {
    match target {
        InsertTarget::Tabs { node, .. } | InsertTarget::Split { node, .. } => *node,
    }
}

/// A split's view of its children, for rendering: its axis, each child's
/// id and slot size.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SplitShape {
    pub(crate) axis: Axis,
    pub(crate) children: Vec<NodeId>,
    pub(crate) sizes: Vec<Option<Points>>,
}

/// What container `node` of `area` is, for the view that renders it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Shape {
    Split(SplitShape),
    Tabs,
}

impl Area {
    /// The shape of container `node` (`None`: not in the area).
    pub(crate) fn shape(&self, node: NodeId) -> Option<Shape> {
        self.trees()
            .find_map(|(_, tree)| tree.find_node(node))
            .map(|n| match n.kind() {
                PaneRef::Split {
                    axis,
                    children,
                    sizes,
                } => Shape::Split(SplitShape {
                    axis,
                    children: children.iter().map(PaneNode::id).collect(),
                    sizes: sizes.to_vec(),
                }),
                PaneRef::Tabs { .. } => Shape::Tabs,
            })
    }

    /// The panels under container `node`.
    pub(crate) fn panels_under(&self, node: NodeId) -> Vec<PanelId> {
        let mut out = Vec::new();
        if let Some(n) = self.trees().find_map(|(_, tree)| tree.find_node(node)) {
            n.walk(&mut |n| {
                if let PaneRef::Tabs { panels, .. } = n.kind() {
                    out.extend(panels.iter().cloned());
                }
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::*;
    use crate::dock::{DockLayout, DockRegion};

    fn area() -> Area {
        Area::from_layout(
            &DockAreaLayout::new(
                DockLayout::h_split()
                    .child(DockLayout::tabs().panel("a").panel("b"), None)
                    .child(DockLayout::tabs().panel("c"), None),
            )
            .with_dock(
                DockPlacement::Left,
                DockRegion::new(DockLayout::tabs().panel("files")),
            ),
        )
    }

    fn group_of(area: &Area, panel: &str) -> NodeId {
        area.group_of_panel(panel).unwrap()
    }

    #[test]
    fn a_layout_round_trips_with_its_ids() {
        let area = area();
        let again = Area::from_layout(&area.to_layout());
        assert_eq!(again, area);
    }

    #[test]
    fn a_panel_moves_between_the_center_and_a_dock() {
        let mut area = area();
        let files = group_of(&area, "files");
        let target = InsertTarget::Tabs {
            node: files,
            ix: None,
            activate: true,
        };
        assert!(area.move_panel("c".into(), target));
        assert_eq!(area.placement_of_panel("c"), Some(DockPlacement::Left));
        let group = area.group(files).unwrap();
        assert_eq!(group.panels, ["files", "c"].map(PanelId::from));
        assert_eq!(group.active_ix, 1);
        // The center's emptied group went, and its split with it.
        assert_eq!(area.groups().len(), 2);
    }

    #[test]
    fn a_move_onto_an_unknown_node_changes_nothing() {
        let mut area = area();
        let before = area.clone();
        let target = InsertTarget::Tabs {
            node: NodeId::from_u64(u64::MAX),
            ix: None,
            activate: true,
        };
        assert!(!area.move_panel("c".into(), target));
        assert_eq!(area, before);
    }

    #[test]
    fn splitting_off_a_panel_makes_a_group_beside_its_target() {
        let mut area = area();
        let c = group_of(&area, "c");
        assert!(area.split_at(c, "a".into(), Placement::Bottom, None));
        let a = group_of(&area, "a");
        assert_ne!(a, c);
        assert_eq!(area.group(a).unwrap().panels, [PanelId::from("a")]);
    }

    #[test]
    fn the_last_panel_of_a_lone_group_stays() {
        let area = area();
        let files = group_of(&area, "files");
        let rules = area.rules(files, false, |_| true);
        assert!(rules.alone);
        assert!(!rules.draggable);
        let ab = group_of(&area, "a");
        assert!(area.rules(ab, false, |_| true).draggable);
        assert!(!area.rules(ab, true, |_| true).draggable);
    }

    #[test]
    fn adding_to_a_missing_dock_makes_it() {
        let mut area = area();
        assert!(area.add_panel("terminal".into(), DockPlacement::Bottom, Some(px(150.))));
        let bottom = area.dock(DockPlacement::Bottom).unwrap();
        assert_eq!(bottom.dock.size(), px(150.));
        assert!(bottom.tree.contains_panel("terminal"));
        let order: Vec<_> = area.docks.iter().map(|pane| pane.placement).collect();
        assert_eq!(order, [DockPlacement::Left, DockPlacement::Bottom]);
    }

    #[test]
    fn a_dock_that_is_not_collapsible_stays_open() {
        let mut area = area();
        assert!(area.set_dock_open(DockPlacement::Left, false));
        assert!(!area.is_dock_open(DockPlacement::Left));
        assert!(!area.displayed()[&PanelId::from("files")]);
        assert!(area.set_dock_open(DockPlacement::Left, true));
        let pane = area.dock_mut(DockPlacement::Left).unwrap();
        pane.dock.set_collapsible(false);
        assert!(!area.set_dock_open(DockPlacement::Left, false));
    }

    #[test]
    fn removing_reports_the_panels_that_left() {
        let mut area = area();
        let before = area.clone();
        assert!(area.remove_panel("b"));
        assert_eq!(before.removed_in(&area), [PanelId::from("b")]);
        // A move removes nothing.
        let mut moved = before.clone();
        let c = group_of(&moved, "c");
        let target = InsertTarget::Tabs {
            node: c,
            ix: Some(0),
            activate: false,
        };
        assert!(moved.move_panel("a".into(), target));
        assert!(before.removed_in(&moved).is_empty());
    }
}
