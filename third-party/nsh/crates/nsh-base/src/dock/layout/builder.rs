//! Describing a layout without building it.

use nsh_core::geometry::{Axis, Points};

use super::{
    node::{NodeKind, PaneNode, PanelId},
    tree::{PaneTree, RootKind},
};

/// Describes a layout in Rust, by the panels' keys.
///
/// ```ignore
/// DockLayout::h_split()
///     .child(DockLayout::tabs().panel("files"), Some(px(240.)))
///     .child(DockLayout::tabs().panel("editor").panel("preview"), None)
/// ```
///
/// [`PaneTree::from_layout`] lowers it into a tree, and
/// [`DockNode::from`](crate::dock::DockNode) into the value a `DockArea`
/// takes.
///
/// Misuse — a panel added to a split, a child container added to a tab group,
/// an active index on anything but a tab group — trips a `debug_assert!` and
/// is otherwise ignored. A type-state builder would reject the same mistakes
/// at compile time, but it needs four marker types and leaks into every
/// consumer signature; the runtime assertion is proportionate for a builder
/// whose misuse shows up on the first debug run.
#[derive(Clone, Debug)]
pub struct DockLayout {
    kind: BuilderKind,
}

#[derive(Clone, Debug)]
enum BuilderKind {
    Split {
        axis: Axis,
        children: Vec<(DockLayout, Option<Points>)>,
    },
    Tabs {
        panels: Vec<PanelId>,
        active_ix: usize,
    },
}

impl DockLayout {
    /// A split whose children sit side by side.
    pub fn h_split() -> Self {
        Self::split(Axis::Horizontal)
    }

    /// A split whose children stack.
    pub fn v_split() -> Self {
        Self::split(Axis::Vertical)
    }

    /// A tab group: panels stacked one at a time, selected from a tab bar.
    pub fn tabs() -> Self {
        Self {
            kind: BuilderKind::Tabs {
                panels: Vec::new(),
                active_ix: 0,
            },
        }
    }

    fn split(axis: Axis) -> Self {
        Self {
            kind: BuilderKind::Split {
                axis,
                children: Vec::new(),
            },
        }
    }

    /// Add a child container to a split. `size` is the child's slot along the
    /// split's axis; `None` leaves it unconstrained.
    pub fn child(mut self, child: DockLayout, size: Option<Points>) -> Self {
        debug_assert!(
            matches!(self.kind, BuilderKind::Split { .. }),
            "child() is only valid on h_split() or v_split()"
        );
        if let BuilderKind::Split { children, .. } = &mut self.kind {
            children.push((child, size));
        }
        self
    }

    /// Add the panel keyed `panel` to a tab group.
    pub fn panel(mut self, panel: impl Into<PanelId>) -> Self {
        debug_assert!(
            matches!(self.kind, BuilderKind::Tabs { .. }),
            "panel() is only valid on tabs()"
        );
        if let BuilderKind::Tabs { panels, .. } = &mut self.kind {
            panels.push(panel.into());
        }
        self
    }

    /// Which tab is displayed. Out-of-range values are clamped by
    /// `normalize` once the layout is installed.
    pub fn active_index(mut self, ix: usize) -> Self {
        debug_assert!(
            matches!(self.kind, BuilderKind::Tabs { .. }),
            "active_index() is only valid on tabs()"
        );
        if let BuilderKind::Tabs { active_ix, .. } = &mut self.kind {
            *active_ix = ix;
        }
        self
    }

    fn build_node(self, tree: &mut PaneTree) -> PaneNode {
        let id = tree.allocate_node_id();
        match self.kind {
            BuilderKind::Split { axis, children } => {
                let mut nodes = Vec::with_capacity(children.len());
                let mut sizes = Vec::with_capacity(children.len());
                for (child, size) in children {
                    nodes.push(child.build_node(tree));
                    sizes.push(size);
                }
                PaneNode::new(
                    id,
                    NodeKind::Split {
                        axis,
                        children: nodes,
                        sizes,
                    },
                )
            }
            BuilderKind::Tabs { panels, active_ix } => {
                PaneNode::new(id, NodeKind::Tabs { panels, active_ix })
            }
        }
    }
}

impl PaneTree {
    /// Build a whole tree from a described layout.
    ///
    /// The `RootKind::Split` wrap mirrors the one in
    /// [`PaneTree::from_state`]: a center whose described root is a tab
    /// group still has to serialize as a `StackPanel`.
    pub fn from_layout(layout: DockLayout, root_kind: RootKind) -> Self {
        let mut tree = PaneTree::new(root_kind);
        let root = layout.build_node(&mut tree);
        tree.install_root(root);
        tree
    }

    /// Install `root`, wrapped in a split when the root must be one, and
    /// normalize.
    pub(crate) fn install_root(&mut self, root: PaneNode) {
        let root = match (self.root_kind(), root.kind_ref()) {
            (RootKind::Split, NodeKind::Split { .. }) | (RootKind::Any, _) => root,
            (RootKind::Split, _) => {
                let id = self.allocate_node_id();
                PaneNode::new(
                    id,
                    NodeKind::Split {
                        axis: Axis::Horizontal,
                        children: vec![root],
                        sizes: vec![None],
                    },
                )
            }
        };

        self.replace_root(root);
        self.normalize();
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::{super::PaneRef, *};

    #[test]
    fn a_described_split_lowers_to_a_split_of_tab_groups() {
        let tree = PaneTree::from_layout(
            DockLayout::h_split()
                .child(DockLayout::tabs().panel("alpha"), Some(px(300.)))
                .child(DockLayout::tabs().panel("beta"), None),
            RootKind::Split,
        );

        assert_eq!(tree.panels().count(), 2);
        let PaneRef::Split {
            axis,
            children,
            sizes,
        } = tree.root().kind()
        else {
            panic!("expected a split root");
        };
        assert_eq!(axis, Axis::Horizontal);
        assert_eq!(children.len(), 2);
        assert_eq!(sizes, &[Some(px(300.)), None]);
        assert!(matches!(children[0].kind(), PaneRef::Tabs { panels, .. } if panels.len() == 1));
    }

    /// Ported from `DockItem::split_with_sizes_adds_each_child_once`, which
    /// guarded a `StackPanel` that once added every child twice.
    #[test]
    fn split_with_sizes_adds_each_child_once() {
        let tree = PaneTree::from_layout(
            DockLayout::h_split()
                .child(DockLayout::tabs().panel("alpha"), None)
                .child(DockLayout::tabs().panel("beta"), None),
            RootKind::Split,
        );

        let PaneRef::Split {
            children, sizes, ..
        } = tree.root().kind()
        else {
            panic!("expected a split root");
        };
        assert_eq!(
            children.len(),
            2,
            "each described child appears exactly once"
        );
        assert_eq!(sizes.len(), children.len());
        assert_ne!(children[0].id(), children[1].id());
    }

    #[test]
    fn a_bare_tab_group_is_wrapped_for_a_split_root() {
        let tree = PaneTree::from_layout(DockLayout::tabs().panel("alpha"), RootKind::Split);

        assert!(matches!(tree.root().kind(), PaneRef::Split { .. }));
    }

    #[test]
    fn an_active_index_selects_the_displayed_tab() {
        let tree = PaneTree::from_layout(
            DockLayout::tabs()
                .panel("alpha")
                .panel("beta")
                .active_index(1),
            RootKind::Any,
        );

        let PaneRef::Tabs { active_ix, .. } = tree.root().kind() else {
            panic!("expected a tab group root");
        };
        assert_eq!(active_ix, 1);
    }
}
