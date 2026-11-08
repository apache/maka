//! The core's layout tree: Taffy's algorithms (flexbox, grid, block, out of
//! flow) run over nodes the core keeps, through Taffy's low-level traits,
//! as `TaffyTree` runs them over its own (`TaffyView`, which this follows
//! call for call). What the core does differently is its own:
//!
//! - **dirty marking goes up to the root, always.** `TaffyTree::mark_dirty`
//!   stops at the first node whose cache is already empty, taking its
//!   ancestors for dirty too; a node of a `display: none` subtree or an
//!   absolutely positioned one always has an empty cache while the nodes
//!   above keep theirs, so a change there was never laid out.
//! - **no hoisted children.** Taffy records, on each containing block, the
//!   absolutely positioned nodes it laid out, for its rounding pass alone;
//!   the core rounds layouts itself (`core::rounded`), so nothing is kept,
//!   and nothing can go stale.
//! - **no rounding**: [`LayoutTree::unrounded_layout`] is what the
//!   algorithms computed.
//! - **relayout boundaries.** A change inside a node whose size its content
//!   cannot change (fixed points both ways, in a flex container, not
//!   shrinking nor aligned by its baseline: [`LayoutTree::is_boundary`])
//!   dirties nothing above it: [`LayoutTree::relayout_boundaries`] lays its
//!   subtree out again with what its parent gave it last time, and only
//!   when what it gives back differs (its overflow, say) is its parent laid
//!   out again. A large page with values changing often costs what changes,
//!   not what the page is.
//! - **leaves that measure as before.** A leaf whose content changed (its
//!   text) dirties nothing when it measures the same for every input the
//!   layout asked of it since its cache was last cleared
//!   ([`LayoutTree::measures_as_before`]): every layout above was computed
//!   from those answers alone, so all of them stand. A price that keeps its
//!   width, a wrapped paragraph that keeps its lines, cost their text.
//! - **holders laid out through.** A holder of the app's JSX in a Rust
//!   component's tree (a slot's, a render's: [`LayoutTree::set_holder`])
//!   that nothing styles and holds one node is not a box of its own: that
//!   node is laid out in its place, an item of the holder's parent, so the
//!   app's `flex: 1`, `alignSelf` or `margin-left: auto` on it act in the
//!   component's layout as on a child of its own. The holder takes the
//!   node's box, and the node sits at its origin
//!   ([`LayoutPartialTree::set_unrounded_layout`]): its native view stays
//!   the holder's child, with the frame it would have as the parent's.

use slab::Slab;
use taffy::{
    AvailableSpace, BlockContext, Cache, CacheTree, DetailedGridInfo, DetailedLayoutInfo, Display,
    FlexDirection, FlexWrap, Layout, LayoutBlockContainer, LayoutContainingBlock,
    LayoutFlexboxContainer, LayoutGridContainer, LayoutInput, LayoutOutput, LayoutPartialTree,
    NodeId, RequestedAxis, RunMode, Size, Style, TraversePartialTree, TraverseTree,
    compute_block_layout, compute_cached_layout, compute_flexbox_layout, compute_grid_layout,
    compute_hidden_layout, compute_oof_layout, compute_root_layout,
};

use super::terminal_layout::{self, Grid, Role};

/// A node: its style, place in the tree, cache and layout, and what
/// measures it when it is a leaf.
struct LayoutNode<C> {
    style: Style,
    /// What the core knows of it that its style does not say: in a
    /// terminal a control has no border and some nodes are left out
    /// ([`LayoutTree::set_role`]).
    role: Role,
    /// In a terminal, the border and padding its last full layout gave it
    /// ([`terminal_layout::Insets`]).
    insets: terminal_layout::Insets,
    parent: Option<NodeId>,
    /// The list a cell is a row of: a cell is laid out apart, a root
    /// ([`LayoutTree::set_host`]).
    host: Option<NodeId>,
    children: Vec<NodeId>,
    cache: Cache,
    unrounded: Layout,
    detailed: DetailedLayoutInfo,
    context: Option<C>,
    /// The core's node it lays out ([`LayoutTree::set_tag`]).
    tag: Option<u32>,
    /// What its parent's last full layout gave it and what it gave back:
    /// what a boundary is laid out again with, and compared to.
    last: Option<(LayoutInput, LayoutOutput)>,
    /// It is a boundary waiting in [`LayoutTree::dirty_boundaries`].
    queued: bool,
    /// A holder of the app's JSX ([`LayoutTree::set_holder`]).
    holder: bool,
    /// Its style is a view's that nothing styles ([`unstyled`]); kept for
    /// holders only.
    unstyled: bool,
    /// Its layout, its style or its children changed, or a node's under it
    /// did, since the core last emitted its frame
    /// ([`LayoutTree::mark_stale`]); a stale node's ancestors are stale.
    stale: bool,
    /// A leaf's answers to the inputs the layout asked of it since its
    /// cache was last cleared, each once: what the layouts above it were
    /// computed from. `None` once there were more than [`MEASURED`] to keep.
    measured: Option<Vec<(LayoutInput, LayoutOutput)>>,
}

/// How many answers of a leaf [`LayoutNode::measured`] keeps: a layout asks
/// a few (its sizes under a measuring pass and the final one); more come of
/// many layouts at other sizes (a window resized), and are not worth
/// measuring again.
const MEASURED: usize = 8;

impl<C> LayoutNode<C> {
    fn new(style: Style, context: Option<C>) -> Self {
        LayoutNode {
            style,
            role: Role::default(),
            insets: terminal_layout::Insets::default(),
            parent: None,
            host: None,
            children: Vec::new(),
            cache: Cache::new(),
            unrounded: Layout::new(),
            stale: true,
            detailed: DetailedLayoutInfo::None,
            context,
            tag: None,
            last: None,
            queued: false,
            holder: false,
            unstyled: false,
            measured: Some(Vec::new()),
        }
    }

    /// Clears its cached layouts, and so what they were computed from.
    fn clear_cache(&mut self) {
        self.cache.clear();
        self.measured = Some(Vec::new());
    }
}

/// The layout nodes of a core, each with a context `C` its leaves are
/// measured with.
pub(crate) struct LayoutTree<C> {
    nodes: Slab<LayoutNode<C>>,
    /// Boundaries a change inside made dirty, to lay out again.
    dirty_boundaries: Vec<NodeId>,
    /// The Cell grid of a terminal surface: laid out in Cells there
    /// ([`terminal_layout`]).
    grid: Option<Grid>,
    /// What a leaf is measured with in a terminal: the algorithm resolves
    /// its sizes and insets in Cells itself ([`terminal_layout::compute`]).
    plain: Style,
}

fn key(node: NodeId) -> usize {
    usize::from(node)
}

impl<C> LayoutTree<C> {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        LayoutTree {
            nodes: Slab::with_capacity(capacity),
            dirty_boundaries: Vec::new(),
            grid: None,
            plain: Style::DEFAULT,
        }
    }

    fn insert(&mut self, style: Style, context: Option<C>, children: &[NodeId]) -> NodeId {
        let mut node = LayoutNode::new(style, context);
        node.children = children.to_vec();
        let id = NodeId::from(self.nodes.insert(node));
        for &child in children {
            self.nodes[key(child)].parent = Some(id);
        }
        id
    }

    /// A new detached node.
    pub(crate) fn new_leaf(&mut self, style: Style) -> NodeId {
        self.insert(style, None, &[])
    }

    /// A new detached node measured with `context`.
    pub(crate) fn new_leaf_with_context(&mut self, style: Style, context: C) -> NodeId {
        self.insert(style, Some(context), &[])
    }

    /// A new detached node holding `children` (detached nodes).
    pub(crate) fn new_with_children(&mut self, style: Style, children: &[NodeId]) -> NodeId {
        self.insert(style, None, children)
    }

    /// The Cell grid of a terminal surface, if it is one.
    pub(crate) fn grid(&self) -> Option<Grid> {
        self.grid
    }

    /// Lays out in a terminal's Cells from now on ([`terminal_layout`]),
    /// or in points with `None`: every node is laid out again. Returns
    /// whether it changed.
    pub(crate) fn set_grid(&mut self, grid: Option<Grid>) -> bool {
        if self.grid == grid {
            return false;
        }
        self.grid = grid;
        for (_, n) in self.nodes.iter_mut() {
            n.clear_cache();
            n.stale = true;
            n.last = None;
        }
        true
    }

    /// The room a list laid out in a terminal leaves its scroll bar across
    /// its cells, in points: a column (a row when horizontal) when it shows
    /// its indicator, as a scroll view's content does
    /// ([`terminal_layout::bar_room`]); none elsewhere.
    pub(crate) fn list_bar_room(&self, node: NodeId, horizontal: bool) -> f32 {
        let Some(grid) = self.grid else {
            return 0.0;
        };
        let n = &self.nodes[key(node)];
        let own = n.unrounded;
        let parent = n.parent.map(|p| {
            let p = &self.nodes[key(p)];
            (p.insets, p.unrounded.size.width)
        });
        terminal_layout::list_bar_room(n.role, own, parent, horizontal, grid)
    }

    /// What the core knows of `node` (`Core::grid_role`): in a terminal a
    /// control has no border and what a terminal cannot show is left out.
    /// Returns whether its layout changed.
    pub(crate) fn set_role(&mut self, node: NodeId, role: Role) -> bool {
        let n = &mut self.nodes[key(node)];
        if n.role == role {
            return false;
        }
        n.role = role;
        if self.grid.is_none() {
            return false;
        }
        // A role decides its parent's borders too (a box of text).
        let parent = self.nodes[key(node)].parent;
        self.mark_dirty(parent.unwrap_or(node));
        self.mark_dirty(node);
        true
    }

    /// Records that `node` lays out the core's node `tag`.
    pub(crate) fn set_tag(&mut self, node: NodeId, tag: u32) {
        self.nodes[key(node)].tag = Some(tag);
    }

    /// Frees `node`, detaching it from its parent; its children are left
    /// without one.
    pub(crate) fn remove(&mut self, node: NodeId) {
        if let Some(parent) = self.nodes[key(node)].parent {
            self.nodes[key(parent)].children.retain(|&c| c != node);
            self.mark_dirty(parent);
        }
        if self.nodes[key(node)].queued {
            self.dirty_boundaries.retain(|&b| b != node);
        }
        let removed = self.nodes.remove(key(node));
        for child in removed.children {
            self.nodes[key(child)].parent = None;
        }
    }

    /// Whether `node` is out of the layout: `display: none`, or left out
    /// in a terminal ([`terminal_layout::LeftOut`]).
    pub(crate) fn displays_none(&self, node: NodeId) -> bool {
        let n = &self.nodes[key(node)];
        n.style.display == Display::None
            || (self.grid.is_some() && terminal_layout::left_out(&n.style, n.role.left_out))
    }

    /// `node`'s style.
    pub(crate) fn style(&self, node: NodeId) -> &Style {
        &self.nodes[key(node)].style
    }

    /// Records that `cell`, laid out apart (a root), is a row of `list`: in
    /// a terminal it keeps the padding its list's box reached across (a
    /// select's options in their popup's panel). Its cache is cleared when
    /// that changes.
    pub(crate) fn set_host(&mut self, cell: NodeId, list: NodeId) {
        let n = &mut self.nodes[key(cell)];
        if n.host != Some(list) {
            n.host = Some(list);
            n.clear_cache();
        }
    }

    /// Records that `node` holds the app's JSX in a Rust component's tree:
    /// unstyled and holding one node, it is laid out through (the module's
    /// docs).
    pub(crate) fn set_holder(&mut self, node: NodeId) {
        let n = &mut self.nodes[key(node)];
        if n.holder {
            return;
        }
        n.holder = true;
        n.unstyled = unstyled(&n.style);
        n.clear_cache();
        if let Some(parent) = n.parent {
            self.mark_dirty(parent);
        }
    }

    /// Whether `node` is a holder laid out through: what its parent lays
    /// out in its place is its one child.
    fn through(&self, node: NodeId) -> bool {
        let n = &self.nodes[key(node)];
        n.holder && n.unstyled && n.children.len() == 1
    }

    /// What is laid out in `node`'s place: `node`, or the node the holders
    /// it is are laid out through.
    fn laid_out(&self, mut node: NodeId) -> NodeId {
        while self.through(node) {
            node = self.nodes[key(node)].children[0];
        }
        node
    }

    /// The node whose layout lays `node` out: its parent, above the holders
    /// laid out through.
    fn layout_parent(&self, node: NodeId) -> Option<NodeId> {
        let mut parent = self.nodes[key(node)].parent?;
        while self.through(parent) {
            parent = self.nodes[key(parent)].parent?;
        }
        Some(parent)
    }

    /// Replaces `node`'s style: its own size may change, so its parent is
    /// laid out again (whether it is a boundary or not).
    pub(crate) fn set_style(&mut self, node: NodeId, style: Style) {
        self.mark_stale(node);
        let n = &mut self.nodes[key(node)];
        if n.holder {
            n.unstyled = unstyled(&style);
        }
        n.style = style;
        n.clear_cache();
        if let Some(parent) = n.parent {
            self.mark_dirty(parent);
        }
    }

    /// Replaces what measures `node`.
    pub(crate) fn set_node_context(&mut self, node: NodeId, context: Option<C>) {
        self.nodes[key(node)].context = context;
        self.mark_dirty(node);
    }

    pub(crate) fn get_node_context(&self, node: NodeId) -> Option<&C> {
        self.nodes[key(node)].context.as_ref()
    }

    pub(crate) fn get_node_context_mut(&mut self, node: NodeId) -> Option<&mut C> {
        self.nodes[key(node)].context.as_mut()
    }

    pub(crate) fn parent(&self, node: NodeId) -> Option<NodeId> {
        self.nodes[key(node)].parent
    }

    #[cfg(test)]
    pub(crate) fn children(&self, node: NodeId) -> &[NodeId] {
        &self.nodes[key(node)].children
    }

    /// Appends `child` (detached) to `parent`'s children.
    pub(crate) fn add_child(&mut self, parent: NodeId, child: NodeId) {
        let index = self.nodes[key(parent)].children.len();
        self.insert_child_at_index(parent, index, child);
    }

    /// Inserts `child` (detached) into `parent` at `index`.
    pub(crate) fn insert_child_at_index(&mut self, parent: NodeId, index: usize, child: NodeId) {
        self.nodes[key(child)].parent = Some(parent);
        self.nodes[key(parent)].children.insert(index, child);
        self.mark_dirty(parent);
        self.mark_stale(child);
    }

    /// Detaches `child` from `parent`.
    pub(crate) fn remove_child(&mut self, parent: NodeId, child: NodeId) {
        self.nodes[key(parent)].children.retain(|&c| c != child);
        self.nodes[key(child)].parent = None;
        self.mark_dirty(parent);
    }

    /// Something in `node` changed (its children, what measures it):
    /// clears the cached layouts of `node` and of every node above it up to
    /// the root (never stopping at a node whose cache is already empty: see
    /// the module's docs), or up to the first boundary on the way, `node`
    /// included, which is queued to be laid out again on its own.
    pub(crate) fn mark_dirty(&mut self, node: NodeId) {
        self.mark_stale(node);
        let mut at = Some(node);
        while let Some(node) = at {
            self.nodes[key(node)].clear_cache();
            if self.is_boundary(node) {
                let n = &mut self.nodes[key(node)];
                if !n.queued {
                    n.queued = true;
                    self.dirty_boundaries.push(node);
                }
                return;
            }
            at = self.nodes[key(node)].parent;
        }
    }

    /// Sets `node`'s unrounded layout; a changed one makes it stale.
    fn set_unrounded(&mut self, node: NodeId, layout: Layout) {
        let n = &mut self.nodes[key(node)];
        if n.unrounded != layout {
            n.unrounded = layout;
            self.mark_stale(node);
        }
    }

    /// `node`'s frame, and those of the nodes above it, are to be emitted
    /// again: something about it changed. All the way up, never stopping at
    /// a stale node: one the core's walks do not reach (a view not made yet,
    /// a list's cell) stays stale under emitted ones.
    pub(crate) fn mark_stale(&mut self, node: NodeId) {
        let mut at = Some(node);
        while let Some(node) = at {
            let n = &mut self.nodes[key(node)];
            n.stale = true;
            at = n.parent;
        }
    }

    /// Whether nothing in `node`'s subtree changed since
    /// [`LayoutTree::emitted`] was last called on it.
    pub(crate) fn stale(&self, node: NodeId) -> bool {
        self.nodes[key(node)].stale
    }

    /// The core emitted `node`'s frame (and goes on to its children).
    pub(crate) fn emitted(&mut self, node: NodeId) {
        self.nodes[key(node)].stale = false;
    }

    /// Whether what changes inside `node` cannot change what its parent's
    /// layout takes from it, so that layout stands: it is placed absolutely
    /// at a size of fixed points both ways, or it has a size of fixed
    /// points both ways in a flex container, and everything the flex
    /// algorithm takes from an item follows from that size alone. Its flex
    /// basis is `auto`, its main size (a percentage basis against a parent
    /// of no definite size, or another length under a content-based
    /// automatic minimum, would follow its content); it does not shrink (its
    /// automatic minimum, its content's, is never above its size, so it
    /// only matters to shrinking); growing takes the free space its parent
    /// and siblings leave; it is not aligned by its baseline; its intrinsic
    /// contributions are its size. And its parent laid it out before. What
    /// it gives back that the size does not fix (overflow, margins) is
    /// compared after ([`LayoutTree::relayout_boundaries`]).
    fn is_boundary(&self, node: NodeId) -> bool {
        // A terminal's sizes follow content, explicit or not.
        if self.grid.is_some() {
            return false;
        }
        let n = &self.nodes[key(node)];
        let Some(parent) = self.layout_parent(node) else {
            return false;
        };
        let fixed = |d: taffy::Dimension| d.into_raw().tag() == taffy::CompactLength::LENGTH_TAG;
        let (style, parent) = (&n.style, &self.nodes[key(parent)].style);
        // Placed out of flow at a size of fixed points: its parent takes
        // nothing from its content, whatever its parent's layout (the
        // cells of a table, rows of a list placed by their offsets).
        if n.last.is_some()
            && style.position == taffy::Position::Absolute
            && style.display != Display::None
            && fixed(style.size.width)
            && fixed(style.size.height)
        {
            return true;
        }
        let baseline = |a: taffy::AlignItems| a.keyword() == taffy::AlignItemsKeyword::Baseline;
        n.last.is_some()
            && parent.display == Display::Flex
            && style.display != Display::None
            && fixed(style.size.width)
            && fixed(style.size.height)
            && style.flex_shrink == 0.0
            && style.flex_basis == taffy::Dimension::auto()
            && !baseline(parent.align_items)
            && !style.align_self.is_some_and(baseline)
    }

    /// What measures the leaf `node` changed (its text, say): whether it
    /// measures with `measure` as it did for every input the layout asked of
    /// it since its cache was last cleared, so that every layout above it
    /// stands and nothing needs laying out again. When it does not, or it
    /// was asked too much to tell, the caller marks it dirty
    /// ([`LayoutTree::mark_dirty`]). A leaf never asked (new, or dirty
    /// already) measures as before: nothing was computed from it.
    /// Whether `node`'s size follows from its style alone both ways: fixed
    /// points, or a percentage of a parent sized in fixed points that way.
    /// What it contains, such as its text, then never changes its size.
    pub(crate) fn sized_by_style(&self, node: NodeId) -> bool {
        let n = &self.nodes[key(node)];
        let Some(parent) = n.parent else {
            return false;
        };
        let parent = &self.nodes[key(parent)].style;
        let style = &n.style;
        let tag = |d: taffy::Dimension| d.into_raw().tag();
        let axis = |own: taffy::Dimension, of: taffy::Dimension| {
            tag(own) == taffy::CompactLength::LENGTH_TAG
                || (tag(own) == taffy::CompactLength::PERCENT_TAG
                    && tag(of) == taffy::CompactLength::LENGTH_TAG)
        };
        n.last.is_some()
            && style.display != Display::None
            && axis(style.size.width, parent.size.width)
            && axis(style.size.height, parent.size.height)
    }

    pub(crate) fn measures_as_before<M>(&mut self, node: NodeId, mut measure: M) -> bool
    where
        M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
    {
        let plain = self.grid.is_some();
        let n = &mut self.nodes[key(node)];
        let Some(measured) = &n.measured else {
            return false;
        };
        let style = if plain { &self.plain } else { &n.style };
        measured
            .iter()
            .all(|(input, output)| measure(*input, node, n.context.as_mut(), style) == *output)
    }

    /// Whether `node` has no cached layout: it changed, or something in it
    /// did, since it was last laid out.
    pub(crate) fn dirty(&self, node: NodeId) -> bool {
        self.nodes[key(node)].cache.is_empty()
    }

    /// `node`'s layout as the algorithms computed it, relative to its
    /// parent, unrounded.
    pub(crate) fn unrounded_layout(&self, node: NodeId) -> &Layout {
        &self.nodes[key(node)].unrounded
    }

    /// Lays out the boundaries a change inside made dirty, each with what
    /// its parent gave it last time; one that gives back what it gave
    /// before (its size, overflow, baselines, margins) leaves its parent's
    /// layout standing, another dirties its parent, as a change of its own
    /// would. Returns the tags of those laid out on their own: their
    /// subtrees' frames are new, nothing else's is.
    pub(crate) fn relayout_boundaries<M>(&mut self, measure: M) -> Vec<u32>
    where
        M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
    {
        let mut relaid = Vec::new();
        if self.dirty_boundaries.is_empty() {
            return relaid;
        }
        let mut view = View {
            tree: self,
            measure,
            framed: false,
        };
        while let Some(node) = view.tree.dirty_boundaries.pop() {
            let n = &mut view.tree.nodes[key(node)];
            n.queued = false;
            let parent = n.parent;
            // Moved or restyled since: no longer one on its own.
            if !view.tree.is_boundary(node) {
                if let Some(parent) = parent {
                    view.tree.mark_dirty(parent);
                }
                continue;
            }
            let (input, before) = view.tree.nodes[key(node)].last.clone().expect("laid out");
            let after = view.compute_child_layout(node, input, None);
            if after == before {
                relaid.extend(view.tree.nodes[key(node)].tag);
            } else if let Some(parent) = parent {
                view.tree.mark_dirty(parent);
            }
        }
        relaid
    }

    /// Lays out the tree under `root` within `available`, measuring leaves
    /// with `measure` (`taffy::TaffyTree::compute_layout_with_measure`'s).
    pub(crate) fn compute_layout_with_measure<M>(
        &mut self,
        root: NodeId,
        available: Size<AvailableSpace>,
        measure: M,
    ) where
        M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
    {
        let mut view = View {
            tree: self,
            measure,
            framed: false,
        };
        compute_root_layout(&mut view, root, available);
    }
}

/// Taffy's flexbox, with a row's width as CSS's shrink-to-fit has it. In
/// definite space Taffy adds up the items' flex bases, so an item with
/// `flex: 1` counts for nothing, however much text it holds: a view around
/// the row, sized by it, ends up narrower than the width its items' heights
/// were measured at. The row's width is its max-content width, up to that
/// space.
fn compute_flex_layout<C, M>(
    view: &mut View<'_, C, M>,
    node: NodeId,
    mut inputs: LayoutInput,
) -> LayoutOutput
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    let n = view.node(node);
    if let (None, AvailableSpace::Definite(space)) =
        (inputs.known_dimensions.width, inputs.available_space.width)
        && matches!(
            n.style.flex_direction,
            FlexDirection::Row | FlexDirection::RowReverse
        )
        && n.style.flex_wrap == FlexWrap::NoWrap
        && n.children
            .iter()
            .any(|&child| view.node(child).style.flex_grow > 0.0)
    {
        let measuring = LayoutInput {
            run_mode: RunMode::ComputeSize,
            axis: RequestedAxis::Horizontal,
            ..inputs
        };
        let bases = compute_flexbox_layout(view, node, measuring).size.width;
        let content = compute_flexbox_layout(
            view,
            node,
            LayoutInput {
                available_space: Size {
                    width: AvailableSpace::MaxContent,
                    ..inputs.available_space
                },
                ..measuring
            },
        )
        .size
        .width;
        inputs.known_dimensions.width = Some(bases.max(content.min(space)));
        inputs.known_dimensions_are_definite.width = true;
    }
    compute_flexbox_layout(view, node, inputs)
}

/// Whether `style` is a view's that nothing styles: React Native's
/// defaults ([`crate::style::unstyled_layout`]), in either direction.
fn unstyled(style: &Style) -> bool {
    let mut plain = crate::style::unstyled_layout();
    plain.direction = style.direction;
    *style == plain
}

/// The tree being laid out, with what measures its leaves: what Taffy's
/// algorithms run over.
struct View<'t, C, M> {
    tree: &'t mut LayoutTree<C>,
    measure: M,
    /// In a terminal, whether the nodes being laid out are inside a
    /// bordered box (`terminal_layout::Tree::framed`).
    framed: bool,
}

impl<C, M> View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    fn node(&self, node: NodeId) -> &LayoutNode<C> {
        &self.tree.nodes[key(node)]
    }

    /// Measures the leaf `node` with `inputs` (with no style of its own
    /// when `plain`: a terminal's), recording the answer
    /// ([`LayoutNode::measured`]).
    fn measure_leaf(&mut self, node: NodeId, inputs: LayoutInput, plain: bool) -> LayoutOutput {
        let tree = &mut *self.tree;
        let n = &mut tree.nodes[key(node)];
        let style = if plain { &tree.plain } else { &n.style };
        let output = (self.measure)(inputs, node, n.context.as_mut(), style);
        if let Some(measured) = &mut n.measured
            && !measured.iter().any(|(asked, _)| *asked == inputs)
        {
            if measured.len() < MEASURED {
                measured.push((inputs, output.clone()));
            } else {
                n.measured = None;
            }
        }
        output
    }

    /// What both `compute_child_layout` and `compute_block_child_layout`
    /// run (`TaffyView::compute_child_layout`).
    fn compute_child_layout(
        &mut self,
        node: NodeId,
        inputs: LayoutInput,
        block: Option<&mut BlockContext<'_>>,
    ) -> LayoutOutput {
        // An ancestor is `display: none`: hidden whatever its own display.
        if inputs.run_mode == RunMode::PerformHiddenLayout {
            self.tree.nodes[key(node)].last = None;
            return compute_hidden_layout(self, node);
        }
        let output = compute_cached_layout(self, node, inputs, |view, node, inputs| {
            if let Some(grid) = view.tree.grid {
                return if view.tree.displays_none(node) {
                    compute_hidden_layout(view, node)
                } else {
                    terminal_layout::compute(view, node, inputs, grid)
                };
            }
            let display = view.node(node).style.display;
            let has_children = !view.node(node).children.is_empty();
            let mut output = match (display, has_children) {
                (Display::None, _) => compute_hidden_layout(view, node),
                (Display::Block, true) => compute_block_layout(view, node, inputs, block),
                (Display::FlowRoot, true) => compute_block_layout(view, node, inputs, None),
                (Display::Flex, true) => compute_flex_layout(view, node, inputs),
                (Display::Grid, true) => compute_grid_layout(view, node, inputs),
                (_, false) => view.measure_leaf(node, inputs, false),
            };
            // The out-of-flow nodes this one is the containing block of, in
            // full layout passes only, as Taffy's tree does.
            if inputs.run_mode == RunMode::PerformLayout {
                compute_oof_layout(view, node, &mut output);
            }
            output
        });
        if inputs.run_mode == RunMode::PerformLayout {
            self.tree.nodes[key(node)].last = Some((inputs, output.clone()));
        }
        output
    }
}

impl<C, M> terminal_layout::Tree for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    fn style(&self, node: NodeId) -> &Style {
        &self.node(node).style
    }

    fn role(&self, node: NodeId) -> Role {
        self.node(node).role
    }

    fn child_count(&self, node: NodeId) -> usize {
        self.node(node).children.len()
    }

    fn child(&self, node: NodeId, index: usize) -> NodeId {
        self.tree.laid_out(self.node(node).children[index])
    }

    fn is_root(&self, node: NodeId) -> bool {
        self.node(node).parent.is_none()
    }

    fn measures(&self, node: NodeId) -> bool {
        self.node(node).context.is_some()
    }

    fn measure(&mut self, node: NodeId, inputs: LayoutInput) -> LayoutOutput {
        self.measure_leaf(node, inputs, true)
    }

    fn layout(&mut self, node: NodeId, inputs: LayoutInput) -> LayoutOutput {
        View::compute_child_layout(self, node, inputs, None)
    }

    fn place(&mut self, node: NodeId, layout: &Layout) {
        LayoutPartialTree::set_unrounded_layout(self, node, layout);
    }

    fn framed(&self) -> bool {
        self.framed
    }

    fn insets(&self, node: NodeId) -> terminal_layout::Insets {
        self.node(node).insets
    }

    fn set_insets(&mut self, node: NodeId, insets: terminal_layout::Insets) {
        self.tree.nodes[key(node)].insets = insets;
    }

    fn set_framed(&mut self, framed: bool) {
        self.framed = framed;
    }

    fn page(&self) -> crate::Color {
        self.tree.grid.map_or(crate::Color::BLACK, |g| g.page)
    }

    fn backdrop(&self, node: NodeId) -> Option<crate::Color> {
        let mut at = self.tree.parent(node);
        while let Some(n) = at {
            let fill = self.tree.nodes[key(n)].role.fill;
            if fill.0 & 0xff == 0xff {
                return Some(fill);
            }
            at = self.tree.parent(n);
        }
        None
    }

    fn placed(&self, node: NodeId) -> Layout {
        *self.tree.unrounded_layout(node)
    }

    fn parent(&self, node: NodeId) -> Option<NodeId> {
        self.tree.parent(node)
    }

    fn host(&self, node: NodeId) -> Option<NodeId> {
        self.node(node).host
    }
}

impl<C, M> TraversePartialTree for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type ChildIter<'a>
        = ChildIds<'a, C>
    where
        Self: 'a;

    fn child_ids(&self, parent: NodeId) -> Self::ChildIter<'_> {
        ChildIds {
            tree: self.tree,
            children: self.node(parent).children.iter(),
        }
    }

    fn child_count(&self, parent: NodeId) -> usize {
        self.node(parent).children.len()
    }

    fn get_child_id(&self, parent: NodeId, index: usize) -> NodeId {
        self.tree.laid_out(self.node(parent).children[index])
    }
}

/// The children a node lays out: its own, each through the holders it is
/// ([`LayoutTree::laid_out`]).
struct ChildIds<'a, C> {
    tree: &'a LayoutTree<C>,
    children: std::slice::Iter<'a, NodeId>,
}

impl<C> Iterator for ChildIds<'_, C> {
    type Item = NodeId;

    fn next(&mut self) -> Option<NodeId> {
        self.children.next().map(|&child| self.tree.laid_out(child))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.children.size_hint()
    }
}

impl<C, M> TraverseTree for View<'_, C, M> where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput
{
}

impl<C, M> LayoutPartialTree for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type CoreContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;

    // `Style`'s default, Taffy's `DefaultCheapStr` with `std`.
    type CustomIdent = String;

    fn get_core_container_style(&self, node: NodeId) -> Self::CoreContainerStyle<'_> {
        &self.node(node).style
    }

    fn set_unrounded_layout(&mut self, node: NodeId, layout: &Layout) {
        // Laid out in the place of the holders around it: the outermost
        // takes its box where it was placed, each holder inside it and the
        // node itself sit at the origin of the one around them.
        let mut node = node;
        let mut own = *layout;
        while let Some(parent) = self.tree.nodes[key(node)].parent
            && self.tree.through(parent)
        {
            own.location = taffy::Point::ZERO;
            self.tree.set_unrounded(node, own);
            node = parent;
            own = Layout {
                location: layout.location,
                size: layout.size,
                ..Layout::with_order(layout.order)
            };
        }
        self.tree.set_unrounded(node, own);
    }

    fn resolve_calc_value(&self, _: *const (), _: f32) -> f32 {
        0.0
    }

    fn compute_child_layout(&mut self, node: NodeId, inputs: LayoutInput) -> LayoutOutput {
        View::compute_child_layout(self, node, inputs, None)
    }
}

impl<C, M> LayoutContainingBlock for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type OofItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_oof_item_style(&self, node: NodeId) -> Self::OofItemStyle<'_> {
        &self.node(node).style
    }

    // Kept for Taffy's rounding pass alone, which the core does not run.
    fn clear_hoisted_children(&mut self, _: NodeId) {}

    fn add_hoisted_children(&mut self, _: NodeId, _: &[NodeId]) {}

    fn get_detailed_layout_info(&self, node: NodeId) -> &DetailedLayoutInfo {
        &self.node(node).detailed
    }
}

impl<C, M> CacheTree for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    fn cache_get(&mut self, node: NodeId, input: &LayoutInput) -> Option<LayoutOutput> {
        self.tree.nodes[key(node)].cache.get(input)
    }

    fn cache_store(&mut self, node: NodeId, input: &LayoutInput, output: LayoutOutput) {
        self.tree.nodes[key(node)].cache.store(input, output);
    }

    fn cache_clear(&mut self, node: NodeId) {
        self.tree.nodes[key(node)].clear_cache();
    }
}

impl<C, M> LayoutBlockContainer for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type BlockContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type BlockItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_block_container_style(&self, node: NodeId) -> Self::BlockContainerStyle<'_> {
        &self.node(node).style
    }

    fn get_block_child_style(&self, child: NodeId) -> Self::BlockItemStyle<'_> {
        &self.node(child).style
    }

    fn compute_block_child_layout(
        &mut self,
        node: NodeId,
        inputs: LayoutInput,
        block: Option<&mut BlockContext<'_>>,
    ) -> LayoutOutput {
        View::compute_child_layout(self, node, inputs, block)
    }
}

impl<C, M> LayoutFlexboxContainer for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type FlexboxContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type FlexboxItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_flexbox_container_style(&self, node: NodeId) -> Self::FlexboxContainerStyle<'_> {
        &self.node(node).style
    }

    fn get_flexbox_child_style(&self, child: NodeId) -> Self::FlexboxItemStyle<'_> {
        &self.node(child).style
    }
}

impl<C, M> LayoutGridContainer for View<'_, C, M>
where
    M: FnMut(LayoutInput, NodeId, Option<&mut C>, &Style) -> LayoutOutput,
{
    type GridContainerStyle<'a>
        = &'a Style
    where
        Self: 'a;
    type GridItemStyle<'a>
        = &'a Style
    where
        Self: 'a;

    fn get_grid_container_style(&self, node: NodeId) -> Self::GridContainerStyle<'_> {
        &self.node(node).style
    }

    fn get_grid_child_style(&self, child: NodeId) -> Self::GridItemStyle<'_> {
        &self.node(child).style
    }

    fn set_detailed_grid_info(&mut self, node: NodeId, info: DetailedGridInfo) {
        self.tree.nodes[key(node)].detailed = DetailedLayoutInfo::Grid(Box::new(info));
    }
}
