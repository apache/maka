//! Dockable layout, as `gpui-base`'s dock: splits and tab groups that an
//! app can rearrange, persist and restore, with no look of its own. This
//! module is its data: the layout algebra, the dock's sizing, the drop
//! geometry, the persisted format and the values JS exchanges with a
//! `DockArea`.
//!
//! # The tree is the source of truth
//!
//! Each region — the center, plus an optional left, right, and bottom dock —
//! is one [`PaneTree`]. A tree is pure data. Containers are addressed by
//! [`NodeId`], panels by [`PanelId`] (the app's key for the panel: `"files"`),
//! which is what lets the layout algebra run as plain tests and lets a
//! whole layout be compared, normalized and serialized as an ordinary
//! value. A container is a `Split` or a `Tabs`; there is no leaf variant,
//! so a panel can only ever live inside a `Tabs`.
//!
//! Both ids are *stable*, and the rest of the design leans on it:
//!
//! - A [`NodeId`] survives every edit and every normalization rule. A
//!   container still present after a drag carries the same id it had before,
//!   which is what keeps what the area rendered for containers the drag never
//!   touched. Ids come from one counter for the whole process, so the four
//!   trees of an area never share one.
//! - A [`PanelId`] is the app's key, so it identifies the panel across any
//!   number of moves between groups and regions. The app renders a panel's
//!   content from its key; the content moves with it instead of being made
//!   again.
//!
//! Every mutation goes through the tree — [`PaneTree::insert_panel`],
//! [`remove_panel`](PaneTree::remove_panel),
//! [`move_panel`](PaneTree::move_panel), [`split`](PaneTree::split),
//! [`set_active`](PaneTree::set_active), and the rest — and each normalizes
//! before returning, so the tree is self-consistent the instant an edit
//! returns. Every edit reports what it did as an [`EditResult`].
//!
//! # The app owns the layout
//!
//! A `DockArea`'s layout is controlled: the app passes a [`DockAreaLayout`]
//! (the center's [`DockNode`] tree and a [`DockRegion`] per dock) and hears
//! every edit — a tab dragged to another group, a split resized, a dock
//! toggled — as the whole new layout, which it passes back. The drag itself
//! runs natively, with no JS on the way; only its result crosses.
//!
//! A layout the app writes may leave node ids out: installing it assigns
//! them ([`PaneTree::from_node`], [`DockAreaLayout::to_trees`]), and the
//! layouts the area reports carry them, so passing a reported layout back
//! keeps every container's identity. Installing also repairs what an
//! app-written layout can get wrong: a repeated id is replaced, a panel
//! listed twice is kept in its first place, `sizes` is fitted to the
//! children, and the shape is normalized.
//!
//! In Rust, [`DockLayout`] describes a layout by the panels' keys:
//!
//! ```ignore
//! use nsh_base::dock::{DockAreaLayout, DockLayout, DockPlacement, DockRegion};
//! use nsh_core::geometry::px;
//!
//! let layout = DockAreaLayout::new(
//!     DockLayout::h_split()
//!         .child(DockLayout::tabs().panel("files"), Some(px(240.)))
//!         .child(DockLayout::tabs().panel("editor"), None),
//! )
//! .with_dock(
//!     DockPlacement::Bottom,
//!     DockRegion::new(DockLayout::tabs().panel("terminal")),
//! );
//! ```
//!
//! # Persisting
//!
//! [`DockAreaState`] is `gpui-base`'s on-disk format, field names and tags
//! frozen, so a layout file is the same in both:
//! [`DockAreaLayout::to_state`] and [`DockAreaLayout::from_state`]
//! round-trip a whole area through it, and [`PaneTree::to_state`] /
//! [`PaneTree::from_state`] one tree. A panel's leaf is the app's
//! ([`PanelSource`] writes it, [`PanelBuilder`] reads its key back);
//! [`PanelKeys`] keeps the key alone, as `{"id": key}`. An app that only
//! keeps its own layouts can as well keep the JS value as it is
//! (`JSON.stringify(layout)`).
//!
//! # No look
//!
//! Nothing here draws. The drop geometry ([`DropPlaceholderBounds`]) says
//! what a drop's placeholder covers, never how it looks or animates; the dock's
//! sizing ([`DockSizing`], [`Dock`]) says how big a dock may be, never what
//! its edge looks like.
//!
//! # Why the layout is data
//!
//! The usual way to build a dock is to make each container a live view that
//! holds its children, so the widget tree *is* the layout. `gpui-base`
//! replaced that, and the three costs it carries are the reason:
//!
//! - **Emptiness has to propagate.** When the last panel leaves a tab group,
//!   the group must remove itself from its parent, which may empty the parent
//!   in turn. With containers as views this is mutual recursion between two
//!   types, reaching upward through parent handles installed after
//!   construction. There is a window in which the tree disagrees with itself.
//! - **Structure and identity are the same thing.** Rearranging the widget
//!   tree means creating and dropping views, so a drag can reset the state of
//!   containers it never touched.
//! - **Nothing is testable without a window.**
//!
//! Here the tree is a value and the rendered containers are its projection.
//! Collapse is [`PaneTree::normalize`]: one post-order pass repeated to a
//! fixpoint, no parent pointers, no deferred work, and idempotent by
//! construction. Identity is a [`NodeId`] that survives every edit and every
//! normalization rule, so reconciliation is a diff rather than a rebuild. And
//! the whole layout algebra runs as plain `#[test]`.
//!
//! What this buys, stated as properties rather than adjectives: a layout can be
//! compared, cloned and serialized as an ordinary value; a steady-state
//! reconcile creates and drops nothing, so a drag leaves untouched panels
//! untouched; and `normalize(normalize(t)) == normalize(t)` holds for every
//! tree, which is what makes the persisted format canonical.
//!
//! # Where this sits among docking libraries
//!
//! Editors tend to build the layout engine into the application — Zed's
//! `PaneGroup` and VS Code's workbench are not reusable outside their hosts.
//! Standalone libraries split the engine from the view to varying degrees:
//! `golden-layout` owns its DOM outright, `FlexLayout` keeps a JSON model
//! beside a React renderer, and `dockview` goes furthest, running a
//! framework-agnostic engine behind thin adapters. All of them still paint
//! their own chrome and expose CSS as the way to change it. This one paints
//! nothing at all: there is no default look to override.
//!
//! The naming follows the same neighborhood where it can. A tab group here is
//! what Zed calls a `Pane` and `dockview` calls a group; a [`Dock`] is Zed's
//! dock; a panel is the dockable content, as in `dockview` — note that
//! VS Code uses "panel" for the bottom *region* instead, and `rc-dock` uses it
//! for the tab container.

mod area;
mod compact;
mod dock_area;
mod dock_placement;
mod drag;
pub mod layout;
mod state;
mod state_convert;
mod tab_group;
mod value;

// The area's code, for the components of `nsh/base` built on it
// (`SplitView`): rendered in their own view, with events of their own.
pub(crate) use dock_area::{AreaCx, area_view};
pub use dock_area::{
    DockArea, DockAreaApi, DockAreaElement, DockAreaEvent, DockAreaProps, DockDropIndicator,
    DockInfo, DockPanel, DockPanelOptions, DockTab, DockTarget, dock_area,
};
pub use dock_placement::{Dock, DockSizing};
pub use drag::DropPlaceholderBounds;
pub use layout::{
    DockLayout, EditResult, InsertTarget, NodeId, PaneNode, PaneRef, PaneTree, PanelId, RootKind,
};
pub use state::{DockAreaState, DockPlacement, DockState, PanelInfo, PanelState};
pub use state_convert::{PanelBuilder, PanelKeys, PanelSource};
pub use value::{DockAreaLayout, DockNode, DockRegion};

// The smallest a dock may be across its edge: a resizable panel's minimum.
pub(crate) use crate::resizable::PANEL_MIN_SIZE;
