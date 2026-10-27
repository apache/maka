//! `DockArea`: a dockable workspace (`gpui-base`'s `DockArea` with its
//! `TabGroup`s), nested splits of tab groups in the center and docks on the
//! left, right and bottom edges, which the user rearranges by dragging
//! tabs, with no look of its own.
//!
//! # The layout is the app's
//!
//! The area renders a [`DockAreaLayout`] (`layout`, controlled, or
//! `defaultLayout`) and reports every edit as the whole new layout
//! (`onLayoutChange`): a tab dragged to another group or to the edge of
//! one, a tab selected, a split or dock resized, a dock opened or closed, a
//! panel added, moved or closed through the ref's methods. A controlled
//! area shows the edit once the app passes the layout back; an
//! uncontrolled one keeps it itself. Edits run on the layout algebra of
//! [`super::PaneTree`] in the core ([`super::area`]: across the trees of the
//! center and the docks), so a drag never waits for JS.
//!
//! # What it renders
//!
//! Each split is a [`crate::ResizablePanelGroup`] of its children (their
//! handles are the `handle` part), each tab group a group frame
//! (`group`) holding its tab bar (`tabBar`, one `tab` per visible panel)
//! and its content frame (`content`), where every panel of the group is
//! placed and only the displayed one shown; each dock a frame (`dock`)
//! across its edge with a [`crate::ResizeHandle`] (`handle` too) on the
//! side facing the center. Every part takes the app's `<part>Class` and
//! `<part>Style`; what is drawn is the app's render functions':
//!
//! - `renderPanel(panel)`: a panel's content, keyed by its id. The core
//!   keeps what the app's function rendered for a key while any element
//!   places it (`core/renders.rs`), so a panel moved to another group or
//!   region, or a tab switched away from, keeps its JS state: its content
//!   moves rather than being made again.
//! - `renderTab(tab)`: what a tab shows; the area wraps it (a press
//!   selects it, a drag moves it; the `tab` role, selected for screen
//!   readers and `selected:` classes). Without one a tab shows the
//!   panel's key.
//! - `renderDropIndicator`, `renderDock`, `renderEmpty`,
//!   `renderDragPreview`: the placeholder where a drag would land, a dock's
//!   own chrome before its layout, what an empty center shows, and what
//!   follows the pointer during a drag.
//!
//! # Drag and drop
//!
//! A tab is dragged with the core's touch responder (`tab_group.rs`): by
//! a pointer (a mouse, a trackpad, a pen; any press on the desktops) once
//! it moves a few points, by a finger after a long press (as iPadOS's drag
//! and drop), so a tab strip still scrolls under a swipe; an iPad with a
//! trackpad or a phone-width browser window driven by a mouse drags as a
//! desktop does. On the desktop OSes every press counts as a pointer's (a
//! mouse pressed before the hover is picked again, as Linux and Windows do
//! only on the next move, still drags at once), so a finger on a
//! touchscreen laptop drags without the long press. When the drag starts the area measures every group's tab bar,
//! tabs and content frame in the root view's coordinates; each move
//! resolves the target from them (the tab strip inserts at the slot under
//! the pointer, a content frame merges in its middle and splits at its
//! edges: [`super::DropPlaceholderBounds`], `split_placement_at`), shows
//! the drop indicator part over that group (an overlay above the area, so
//! the handles' lines never cover it), and the release applies one
//! move. A locked area, a zoomed one, and a group's last panel when
//! nothing sits beside the group drag nothing.
//!
//! # Its bounds
//!
//! The area is as big as its parent makes it and never more: its root
//! clips and takes no minimum from its content, a dock shows at its size
//! clamped to what the area leaves it (`DockSizing::clamp`, the center's
//! minimum kept) and shrinks with the rest when even that does not fit, and
//! the splits' minimum sizes yield to a group smaller than their sum.
//!
//! # Compact width
//!
//! Below 600 points of the area's own width, as it is laid out (phones,
//! narrow split views, windows and containers: NSH is embedded, so a dock
//! in a narrow pane of a wide window is compact too; the window's width
//! stands in until the area is laid out; `compact` decides instead when
//! set) the layout keeps its data
//! and changes its presentation (`compact.rs`): the center shows one tab
//! group at a time, its tab bar listing every center panel; the side docks
//! are drawers over the center from their edge and the bottom dock a sheet,
//! one presented at a time (none at first: `toggleDock` presents one),
//! dismissed by a press on its backdrop, Escape or back; the layout's
//! `open` stays the full presentation's. A drag there only reorders tabs.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use nsh_core::{
    element::{Renderer, Style},
    geometry::{Axis, Bounds, Point, Points, Size},
    prelude::*,
};

use super::{
    PANEL_MIN_SIZE,
    area::{Area, Shape},
    dock_placement::DockSizing,
    layout::{InsertTarget, NodeId, PanelId},
    state::DockPlacement,
    value::DockAreaLayout,
};
use crate::resizable::{
    HANDLE_SIZE, HandleEdge, resizable_panel, resizable_panel_group, resize_handle,
};

/// Below this width of its own the area presents itself compactly.
const COMPACT_WIDTH: Points = px(600.0);

// --- The values JS exchanges ------------------------------------------------

/// A panel, as `renderPanel` renders it.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockPanel {
    /// The panel's key, as the layout lists it.
    pub id: PanelId,
}

/// A tab, as `renderTab` and `renderDragPreview` render it.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockTab {
    /// The panel's key.
    pub panel: PanelId,
    /// The id of the tab group it is in.
    pub group: u64,
    /// Its place among the group's visible tabs.
    pub index: usize,
    /// It is the group's displayed tab.
    pub active: bool,
    /// The area would close it (`closePanel`): it is closable, and its
    /// group may give it away.
    pub closable: bool,
    /// Its group is zoomed.
    pub zoomed: bool,
}

/// Where a drag would land, as `renderDropIndicator` renders it.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockDropIndicator {
    /// The id of the tab group it lands on.
    pub group: u64,
    /// The edge of the group it splits off (`null`: into the group).
    #[prop(skip_none)]
    pub side: Option<Placement>,
    /// The slot in the group's tab bar it goes to, when dropped on the bar.
    #[prop(skip_none)]
    pub index: Option<usize>,
}

/// A dock, as `renderDock` renders it.
#[derive(Clone, Debug, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockInfo {
    /// Its edge.
    pub placement: DockPlacement,
    /// Whether it is open.
    pub open: bool,
    /// Its size across its edge, in points.
    pub size: Points,
    /// Whether dragging its edge below its minimum closes it.
    pub collapsible: bool,
}

impl Default for DockInfo {
    fn default() -> Self {
        Self {
            placement: DockPlacement::Left,
            open: true,
            size: super::Dock::DEFAULT_SIZE,
            collapsible: true,
        }
    }
}

/// What a panel allows (`panels`), the app's counterpart of `gpui-base`'s
/// `Panel` hooks; a panel not listed allows everything.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockPanelOptions {
    /// The panel's key.
    pub id: PanelId,
    /// It may be closed (default true).
    #[prop(skip_none)]
    pub closable: Option<bool>,
    /// Its group may zoom while it is displayed (default true).
    #[prop(skip_none)]
    pub zoomable: Option<bool>,
    /// It shows (default true): a hidden panel keeps its place and comes
    /// back there; a group or split whose panels are all hidden takes no
    /// space.
    #[prop(skip_none)]
    pub visible: Option<bool>,
}

impl DockPanelOptions {
    /// The options of panel `id`, everything allowed.
    pub fn new(id: impl Into<PanelId>) -> Self {
        Self {
            id: id.into(),
            ..Default::default()
        }
    }
}

/// Where `movePanel` puts a panel.
#[derive(Clone, Debug, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct DockTarget {
    /// The id of the container it goes to or beside (a tab group's for
    /// `index`).
    pub group: u64,
    /// The edge of `group` it splits off into a new tab group (`null`:
    /// into the tab group).
    #[prop(skip_none)]
    pub side: Option<Placement>,
    /// Its slot among the group's tabs (default: last).
    #[prop(skip_none)]
    pub index: Option<usize>,
    /// It becomes the displayed tab (default true).
    #[prop(skip_none)]
    pub activate: Option<bool>,
    /// Its slot along the new split, in points, when it splits (default:
    /// half of what it lands beside).
    #[prop(skip_none)]
    pub size: Option<Points>,
}

impl DockTarget {
    fn insert_target(&self) -> InsertTarget {
        let node = NodeId::from_u64(self.group);
        match self.side {
            Some(placement) => InsertTarget::Split {
                node,
                placement,
                size: self.size,
            },
            None => InsertTarget::Tabs {
                node,
                ix: self.index,
                activate: self.activate.unwrap_or(true),
            },
        }
    }
}

// --- The component ----------------------------------------------------------

/// The props of [`DockArea`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct DockAreaProps {
    /// The layout (controlled): the app owns it, passing back what
    /// `onLayoutChange` reports. Without it the area keeps its own,
    /// starting from `defaultLayout`.
    pub layout: Prop<Option<DockAreaLayout>>,
    /// The layout at first, while `layout` is not set.
    pub default_layout: Prop<Option<DockAreaLayout>>,
    /// Nothing is rearranged: no drags, no drops, no closes.
    #[prop(default)]
    pub locked: Prop<bool>,
    /// The compact presentation (one group in the center, the docks as
    /// drawers and a sheet) when true, the full one when false; by default
    /// compact below 600 points of the area's own width.
    pub compact: Prop<Option<bool>>,
    /// What each panel allows (closable, zoomable, visible), by key.
    #[prop(default)]
    pub panels: Prop<Vec<DockPanelOptions>>,
    /// A panel's content, keyed by its id: it keeps its state as the panel
    /// moves between groups and docks.
    pub render_panel: Prop<Option<Renderer<DockPanel>>>,
    /// What a tab shows (the panel's key without one); the area makes it
    /// the tab: a press selects it, a drag moves it. It is one view inside
    /// the tab, so a row of a title and a close button is a `flex-row` view
    /// of them.
    pub render_tab: Prop<Option<Renderer<DockTab>>>,
    /// What shows where a drag would land, placed over the part of the
    /// group it would take.
    pub render_drop_indicator: Prop<Option<Renderer<DockDropIndicator>>>,
    /// A dock's own chrome (a title strip, a collapse button), before its
    /// layout.
    pub render_dock: Prop<Option<Renderer<DockInfo>>>,
    /// What an empty center shows.
    pub render_empty: Prop<Option<Renderer<DockPlacement>>>,
    /// What follows the pointer while a tab is dragged.
    pub render_drag_preview: Prop<Option<Renderer<DockTab>>>,
    /// The classes of each tab group's frame.
    pub group_class: Prop<Option<SharedString>>,
    /// The style of each tab group's frame.
    #[prop(default)]
    pub group_style: Prop<Style>,
    /// The classes of each tab bar (`flex-row` for a row).
    pub tab_bar_class: Prop<Option<SharedString>>,
    /// The style of each tab bar.
    #[prop(default)]
    pub tab_bar_style: Prop<Style>,
    /// The classes of each tab (`selected:` for the displayed one).
    pub tab_class: Prop<Option<SharedString>>,
    /// The style of each tab.
    #[prop(default)]
    pub tab_style: Prop<Style>,
    /// The classes of each group's content frame, where its panels show.
    pub content_class: Prop<Option<SharedString>>,
    /// The style of each group's content frame.
    #[prop(default)]
    pub content_style: Prop<Style>,
    /// The classes of the drop indicator.
    pub drop_indicator_class: Prop<Option<SharedString>>,
    /// The style of the drop indicator.
    #[prop(default)]
    pub drop_indicator_style: Prop<Style>,
    /// The classes of the indicator of each handle, between the groups of
    /// a split and at each dock's edge (`group-hover:` and `group-active:`
    /// restyle it while the pointer is over the handle and while it is
    /// dragged).
    pub handle_class: Prop<Option<SharedString>>,
    /// The style of the indicator of each handle.
    #[prop(default)]
    pub handle_style: Prop<Style>,
    /// The classes of the thumb of each handle: a grip centered on its
    /// indicator, drawn upright as on a vertical line and turned a quarter
    /// on a horizontal one (`ResizablePanelGroup`'s `handleThumbClass`).
    pub handle_thumb_class: Prop<Option<SharedString>>,
    /// The style of the thumb of each handle.
    #[prop(default)]
    pub handle_thumb_style: Prop<Style>,
    /// What screen readers say for each handle (an `adjustable` element):
    /// what dragging it resizes.
    pub handle_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of each dock's frame.
    pub dock_class: Prop<Option<SharedString>>,
    /// The style of each dock's frame.
    #[prop(default)]
    pub dock_style: Prop<Style>,
    /// Compact: the classes of the side docks' drawers.
    pub drawer_class: Prop<Option<SharedString>>,
    /// Compact: the style of the side docks' drawers.
    #[prop(default)]
    pub drawer_style: Prop<Style>,
    /// Compact: the classes of the bottom dock's sheet.
    pub sheet_class: Prop<Option<SharedString>>,
    /// Compact: the style of the bottom dock's sheet.
    #[prop(default)]
    pub sheet_style: Prop<Style>,
    /// Compact: the classes of the backdrop behind an open drawer or
    /// sheet, which takes the presses that close it.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// Compact: the style of the backdrop.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
}

/// The events of a [`DockArea`].
#[derive(Debug, Clone, PartialEq, Event)]
#[allow(
    clippy::large_enum_variant,
    reason = "one event per edit, handed on as it is"
)]
pub enum DockAreaEvent {
    /// The layout changed (a drag, a selection, a resize, a dock opened or
    /// closed, a method of the ref): the whole new layout, every id in it.
    /// Pass it back as `layout` (and save it, debounced: it comes on every
    /// edit).
    #[args(layout)]
    LayoutChange(DockAreaLayout),
    /// A panel became, or stopped being, the displayed tab of its group
    /// (a closed dock displays none). Once per change; a panel that leaves
    /// is not told `false`: `onPanelRemove` is its end.
    #[args(panel, active)]
    PanelActiveChange(PanelId, bool),
    /// A panel left the area for good (closed or removed, or not in a new
    /// layout); one moved never hears it.
    #[args(panel)]
    PanelRemove(PanelId),
    /// A group zoomed in (with the panel it displays) or out (`null`).
    #[args(panel)]
    ZoomChange(Option<PanelId>),
    /// A dock opened or closed, as it shows: in the full presentation its
    /// `open` changed; at compact width it was presented as a drawer (a
    /// sheet at the bottom) or dismissed. At first it reports where what
    /// shows differs from the layout's `open` (a compact area presents no
    /// dock), so an app that starts from the layout follows it with this
    /// event alone.
    #[args(placement, open)]
    DockOpenChange(DockPlacement, bool),
}

/// The methods of a [`DockArea`]'s ref.
pub struct DockAreaApi {
    a: AreaCx,
}

#[methods]
impl DockAreaApi {
    /// The layout shown.
    pub fn layout(&self) -> DockAreaLayout {
        self.a.area.get_untracked().to_layout()
    }

    /// Adds panel `panel` to region `placement` (default the center): into
    /// its first tab group, displayed; a dock missing there is made,
    /// `size` across. A panel the area holds moves there.
    pub fn add_panel(
        &self,
        panel: PanelId,
        placement: Option<DockPlacement>,
        size: Option<Points>,
    ) {
        let placement = placement.unwrap_or(DockPlacement::Center);
        self.a.edit(|area| area.add_panel(panel, placement, size));
    }

    /// Removes panel `panel`, whatever its options say.
    pub fn remove_panel(&self, panel: PanelId) {
        self.a.edit(|area| area.remove_panel(panel.as_str()));
    }

    /// Closes panel `panel` as its tab would: unless the area is locked,
    /// the panel is not closable, or it is the last panel of a group with
    /// nothing beside it.
    pub fn close_panel(&self, panel: PanelId) {
        self.a.close(&panel);
    }

    /// Moves panel `panel` to `target` (a panel the area does not hold yet
    /// is added there).
    pub fn move_panel(&self, panel: PanelId, target: DockTarget) {
        let target = target.insert_target();
        self.a.edit(|area| area.move_panel(panel, target));
    }

    /// Puts panel `panel` in a new tab group on the `side` of container
    /// `group`.
    pub fn split_at(&self, group: u64, panel: PanelId, side: Placement) {
        let node = NodeId::from_u64(group);
        self.a.edit(|area| area.split_at(node, panel, side, None));
    }

    /// Displays panel `panel` in its group.
    pub fn select_panel(&self, panel: PanelId) {
        self.a.select(&panel);
    }

    /// Displays tab `index` of tab group `group`.
    pub fn select_tab(&self, group: u64, index: usize) {
        let node = NodeId::from_u64(group);
        self.a.edit(|area| area.set_active(node, index));
    }

    /// Opens the dock at `placement` when it is closed, closes it when it
    /// is open (unless it is not collapsible). At compact width it
    /// presents the dock as a drawer (a sheet at the bottom), dismissing
    /// the one presented, or dismisses it; the layout stays as it is.
    pub fn toggle_dock(&self, placement: DockPlacement) {
        let open = self.a.is_dock_open_untracked(placement);
        self.a.set_dock_open(placement, !open);
    }

    /// Opens (`true`) or closes the dock at `placement` (at compact width:
    /// presents or dismisses it, as `toggleDock`).
    pub fn set_dock_open(&self, placement: DockPlacement, open: bool) {
        self.a.set_dock_open(placement, open);
    }

    /// Sets the size of the dock at `placement` across its edge (never
    /// below 100 points).
    pub fn set_dock_size(&self, placement: DockPlacement, size: Points) {
        self.a.edit(|area| area.set_dock_size(placement, size));
    }

    /// Zooms tab group `group` in (it fills the area) or, when it is
    /// zoomed, out; without `group`, the zoomed group out.
    pub fn toggle_zoom(&self, group: Option<u64>) {
        match group {
            Some(group) => self.a.toggle_zoom(NodeId::from_u64(group)),
            None => self.a.set_zoom(None),
        }
    }

    /// The zoomed tab group's id (`null`: none).
    pub fn zoomed_group(&self) -> Option<u64> {
        self.a.zoomed.get_untracked().map(NodeId::as_u64)
    }

    /// The id of the tab group holding panel `panel`.
    pub fn group_of(&self, panel: PanelId) -> Option<u64> {
        self.a
            .area
            .with_untracked(|area| area.group_of_panel(panel.as_str()))
            .map(NodeId::as_u64)
    }
}

/// A dockable workspace (`gpui-base`'s `DockArea`): splits of tab groups in
/// the center and docks on its left, right and bottom edges, which the
/// user rearranges by dragging tabs between groups, to the edges of a
/// group (a new split) or onto a tab bar, resizes by dragging the splits'
/// and docks' handles, and closes and zooms through the ref. It owns the
/// behavior (the drags, run natively, resizing, selection, the rules of
/// what may move and close, focus of the tab role) and draws nothing: the
/// app's render functions draw the panels and tabs (`renderPanel`, keyed by
/// panel, so a panel keeps its state wherever it moves; `renderTab`) and
/// the optional parts (`renderDropIndicator`, `renderDock`, `renderEmpty`,
/// `renderDragPreview`), and its `<part>Class` / `<part>Style` props style
/// every part. The layout is controlled (`layout` with `onLayoutChange`,
/// or `defaultLayout`). Below 600 points of its own width (or with
/// `compact`) it shows one group at a time and its docks as drawers and a
/// sheet.
#[component(methods = DockAreaApi)]
pub fn DockArea(props: DockAreaProps, cx: Scope<DockAreaEvent>) -> impl IntoElement {
    let a = AreaCx::new(props, cx);
    cx.methods(DockAreaApi { a });
    a.watch();
    // Its size is its parent's: what it holds never makes it bigger (no
    // minimum from its content), and what does not fit is clipped.
    view()
        .relative()
        .flex_row()
        .overflow_hidden()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .on_layout(move |frame: &Bounds<Points>| a.size.set(frame.size))
        .child(
            when(
                move || a.compact.get(),
                move || super::compact::compact_view(a),
            )
            .otherwise(move || regular_view(a)),
        )
        .child(super::tab_group::drop_indicator(a))
        .child(drag_preview(a))
}

// --- The area's state -------------------------------------------------------

/// What a drag of a tab is about, and where it would land.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TabDrag {
    pub(crate) panel: PanelId,
    /// The group it came from (`None`: the compact strip's).
    pub(crate) source: Option<NodeId>,
    /// The pointer, in the root view's coordinates.
    pub(crate) pointer: Point<Points>,
    pub(crate) target: Option<DropAt>,
}

/// Where a drag would land.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DropAt {
    pub(crate) group: NodeId,
    pub(crate) side: Option<Placement>,
    pub(crate) index: Option<usize>,
    /// The group's content frame, in the root view's coordinates.
    pub(crate) content: Bounds<Points>,
}

/// The views of a tab group a drag measures: its tab bar, its tabs and
/// its content frame (`None` group: the compact strip).
#[derive(Clone)]
pub(crate) struct GroupRefs {
    pub(crate) group: Option<NodeId>,
    pub(crate) bar: ElementRef,
    pub(crate) content: Option<ElementRef>,
    pub(crate) tabs: Rc<RefCell<Vec<(PanelId, ElementRef)>>>,
}

/// A group's measured views, in the root view's coordinates.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Zone {
    pub(crate) group: Option<NodeId>,
    pub(crate) bar: Option<Bounds<Points>>,
    pub(crate) content: Option<Bounds<Points>>,
    pub(crate) tabs: Vec<(PanelId, Bounds<Points>)>,
}

/// A dock's size while its handle is dragged.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DockDrag {
    placement: DockPlacement,
    from: Points,
    raw: Points,
}

/// What the area's views and listeners share (`Copy`: handles).
#[derive(Clone, Copy)]
pub(crate) struct AreaCx {
    pub(crate) props: DockAreaProps,
    pub(crate) cx: Scope<DockAreaEvent>,
    /// The layout shown: the app's, or the area's own.
    pub(crate) area: Memo<Area>,
    own: Signal<Area>,
    pub(crate) zoomed: Signal<Option<NodeId>>,
    pub(crate) drag: Signal<Option<TabDrag>>,
    pub(crate) zones: Stored<Vec<Zone>>,
    pub(crate) refs: Stored<Vec<GroupRefs>>,
    pub(crate) compact: Memo<bool>,
    /// Compact: the center group shown.
    pub(crate) current: Signal<Option<NodeId>>,
    /// Compact: the dock presented as a drawer or the sheet, at most one;
    /// none whenever the area becomes compact. The layout's `open` is the
    /// full presentation's and compact leaves it alone.
    pub(crate) presented: Signal<Option<DockPlacement>>,
    /// The area's size.
    size: Signal<Size<Points>>,
    dock_drag: Signal<Option<DockDrag>>,
    /// The last edit of a controlled area, until the app passes a layout.
    pending: Stored<Option<Area>>,
}

impl AreaCx {
    fn new(props: DockAreaProps, cx: Scope<DockAreaEvent>) -> Self {
        let own = signal(untracked(|| {
            Area::from_layout(&props.default_layout.get().unwrap_or_default())
        }));
        let area = computed(move || match props.layout.get() {
            Some(layout) => Area::from_layout(&layout),
            None => own.get(),
        });
        let size = signal(Size::<Points>::default());
        // The area's own width (NSH is embedded: a dock in a narrow
        // container is compact too); the window's until it is laid out.
        let compact = computed(move || {
            props.compact.get().unwrap_or_else(|| {
                let width = size.get().width;
                let width = if width > Points::ZERO {
                    width
                } else {
                    window().width
                };
                width < COMPACT_WIDTH
            })
        });
        Self {
            props,
            cx,
            area,
            own,
            zoomed: signal(None),
            drag: signal(None),
            zones: stored(Vec::new()),
            refs: stored(Vec::new()),
            compact,
            current: signal(None),
            presented: signal(None),
            size,
            dock_drag: signal(None),
            pending: stored(None),
        }
    }

    /// Applies `f` to the layout; when it changed something, reports the
    /// new layout (and the panels that left), keeping it when the app does
    /// not control it.
    pub(crate) fn edit(self, f: impl FnOnce(&mut Area) -> bool) -> bool {
        // Edits made before the app passes the last one back build on it,
        // so several in one turn (a method called in a loop) all count.
        let before = self
            .pending
            .with(|p| p.clone())
            .unwrap_or_else(|| self.area.get_untracked());
        let mut next = before.clone();
        if !f(&mut next) || next == before {
            return false;
        }
        if self.props.layout.get_untracked().is_none() {
            self.own.set(next.clone());
        } else {
            self.pending.replace(Some(next.clone()));
            // An app that does not take it back leaves the layout it has.
            let pending = self.pending;
            set_timeout(std::time::Duration::ZERO, move || {
                pending.replace(None);
            });
        }
        self.cx.emit(DockAreaEvent::LayoutChange(next.to_layout()));
        for panel in before.removed_in(&next) {
            self.cx.emit(DockAreaEvent::PanelRemove(panel));
        }
        true
    }

    /// The options of panel `panel` (tracked).
    pub(crate) fn options(self, panel: &PanelId) -> DockPanelOptions {
        self.props.panels.with(|panels| {
            panels
                .iter()
                .find(|options| options.id == *panel)
                .cloned()
                .unwrap_or_else(|| DockPanelOptions::new(panel.clone()))
        })
    }

    /// Whether panel `panel` shows (tracked).
    pub(crate) fn visible(self, panel: &PanelId) -> bool {
        self.options(panel).visible.unwrap_or(true)
    }

    /// Whether tab group `node`'s tabs can be dragged out of it and closed
    /// (tracked).
    pub(crate) fn draggable(self, node: NodeId) -> bool {
        let locked = self.props.locked.get() || self.zoomed.get().is_some();
        self.area
            .with(|area| area.rules(node, locked, |p| self.visible(p)).draggable)
    }

    /// Whether the area would close panel `panel` (tracked).
    pub(crate) fn closable(self, panel: &PanelId) -> bool {
        let Some(node) = self.area.with(|area| area.group_of_panel(panel.as_str())) else {
            return false;
        };
        self.options(panel).closable.unwrap_or(true)
            && !self.props.locked.get()
            && self.draggable_ignoring_zoom(node)
    }

    fn draggable_ignoring_zoom(self, node: NodeId) -> bool {
        let locked = self.props.locked.get();
        self.area
            .with(|area| area.rules(node, locked, |p| self.visible(p)).draggable)
    }

    pub(crate) fn close(self, panel: &PanelId) {
        if untracked(|| self.closable(panel)) {
            self.edit(|area| area.remove_panel(panel.as_str()));
        }
    }

    pub(crate) fn select(self, panel: &PanelId) {
        if let Some(node) = self
            .area
            .with_untracked(|area| area.group_of_panel(panel.as_str()))
        {
            self.current.set(Some(node));
        }
        self.edit(|area| area.select_panel(panel.as_str()));
    }

    /// Whether the dock at `placement` shows (tracked): open in the layout,
    /// or at compact width presented.
    pub(crate) fn is_dock_open(self, placement: DockPlacement) -> bool {
        if !self.area.with(|area| area.dock(placement).is_some()) {
            return false;
        }
        match self.compact.get() {
            true => self.presented.get() == Some(placement),
            false => self.area.with(|area| area.is_dock_open(placement)),
        }
    }

    pub(crate) fn is_dock_open_untracked(self, placement: DockPlacement) -> bool {
        untracked(|| self.is_dock_open(placement))
    }

    /// Opens or closes the dock at `placement`: an edit of the layout, or
    /// at compact width the presented dock.
    pub(crate) fn set_dock_open(self, placement: DockPlacement, open: bool) {
        if !self.compact.get_untracked() {
            self.edit(|area| area.set_dock_open(placement, open));
            return;
        }
        let has = self
            .area
            .with_untracked(|area| area.dock(placement).is_some());
        let presented = self.presented.get_untracked();
        match open {
            true if has => self.presented.set(Some(placement)),
            false if presented == Some(placement) => self.presented.set(None),
            _ => {}
        }
    }

    pub(crate) fn toggle_zoom(self, node: NodeId) {
        if self.zoomed.get_untracked() == Some(node) {
            self.set_zoom(None);
            return;
        }
        let zoomable = untracked(|| {
            self.area
                .with(|area| area.group(node))
                .and_then(|group| group.active().cloned())
                .is_some_and(|panel| self.options(&panel).zoomable.unwrap_or(true))
        });
        if zoomable {
            self.set_zoom(Some(node));
        }
    }

    pub(crate) fn set_zoom(self, node: Option<NodeId>) {
        if self.zoomed.get_untracked() == node {
            return;
        }
        self.zoomed.set(node);
        let panel = node.and_then(|node| {
            self.area
                .with_untracked(|area| area.group(node))
                .and_then(|group| group.active().cloned())
        });
        self.cx.emit(DockAreaEvent::ZoomChange(panel));
    }

    /// The effects that follow the layout: which panels are displayed
    /// (each edge once, deactivations first), and the zoom ending with its
    /// group.
    fn watch(self) {
        effect(move || {
            self.area.with(|_| ());
            self.pending.replace(None);
        });
        // Entering or leaving the compact presentation presents nothing.
        let was_compact = stored(None::<bool>);
        effect(move || {
            let compact = self.compact.get();
            if was_compact
                .replace(Some(compact))
                .is_some_and(|was| was != compact)
            {
                untracked(|| self.presented.set(None));
            }
        });
        // Each dock's shown state, reported as it changes.
        let shown = stored(None::<[bool; 3]>);
        effect(move || {
            let now = DockPlacement::DOCKS.map(|p| self.is_dock_open(p));
            // At first, against what the layout says (`open`): an app
            // that starts from the layout hears where the area differs
            // (compact from the start shows no dock).
            let before = shown.replace(Some(now)).unwrap_or_else(|| {
                untracked(|| {
                    DockPlacement::DOCKS.map(|p| self.area.with(|area| area.is_dock_open(p)))
                })
            });
            {
                untracked(|| {
                    for (ix, placement) in DockPlacement::DOCKS.into_iter().enumerate() {
                        if before[ix] != now[ix] {
                            self.cx
                                .emit(DockAreaEvent::DockOpenChange(placement, now[ix]));
                        }
                    }
                });
            }
        });
        let told = stored(HashMap::<PanelId, bool>::new());
        effect(move || {
            let now = self.area.with(Area::displayed);
            untracked(|| {
                let mut off = Vec::new();
                let mut on = Vec::new();
                told.with(|told| {
                    let mut ids: Vec<&PanelId> = now.keys().collect();
                    ids.sort();
                    for panel in ids {
                        let active = now[panel];
                        match told.get(panel) {
                            Some(was) if *was == active => {}
                            None if !active => {}
                            _ if active => on.push(panel.clone()),
                            _ => off.push(panel.clone()),
                        }
                    }
                });
                told.replace(now);
                for panel in off {
                    self.cx.emit(DockAreaEvent::PanelActiveChange(panel, false));
                }
                for panel in on {
                    self.cx.emit(DockAreaEvent::PanelActiveChange(panel, true));
                }
            });
        });
        effect(move || {
            let gone = self
                .zoomed
                .get()
                .is_some_and(|node| !self.area.with(|area| area.group(node).is_some()));
            if gone {
                untracked(|| self.set_zoom(None));
            }
        });
    }
}

// --- The full presentation --------------------------------------------------

fn regular_view(a: AreaCx) -> impl IntoElement {
    let zoomed = move || a.zoomed.get();
    view()
        .flex_1()
        .flex_row()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .child(
            // The layout stays placed while a group is zoomed, so what it
            // shows keeps its state; the zoomed group's own view places
            // that group's panels last, which shows them there.
            view()
                .flex_1()
                .flex_row()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .style_when(move || zoomed().is_some(), |s| s.hidden())
                .child(dock_frame(a, DockPlacement::Left))
                .child(
                    view()
                        .flex_1()
                        .flex_col()
                        .min_w(px(0.0))
                        .min_h(px(0.0))
                        .child(
                            view()
                                .flex_1()
                                .min_h(px(0.0))
                                .child(region(a, DockPlacement::Center)),
                        )
                        .child(dock_frame(a, DockPlacement::Bottom)),
                )
                .child(dock_frame(a, DockPlacement::Right)),
        )
        .child(dynamic(move || {
            zoomed().map(|node| {
                view()
                    .flex_1()
                    .min_w(px(0.0))
                    .min_h(px(0.0))
                    .child(super::tab_group::tab_group(a, node))
            })
        }))
}

/// The layout of region `placement`: its root container, made again when
/// the root is another one.
pub(crate) fn region(a: AreaCx, placement: DockPlacement) -> AnyElement {
    let root = computed(move || {
        a.area
            .with(|area| area.tree(placement).map(|tree| tree.root().id()))
    });
    let empty = computed(move || {
        a.area.with(|area| {
            area.tree(placement)
                .is_none_or(|tree| tree.panels().next().is_none())
        })
    });
    view()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .child(
            when(
                move || empty.get(),
                move || {
                    dynamic(move || {
                        let r = a.props.render_empty.get();
                        r.filter(|_| placement == DockPlacement::Center)
                            .map(|r| r.render("empty", placement).flex_1())
                    })
                },
            )
            .otherwise(move || dynamic(move || root.get().map(|root| node_view(a, root)))),
        )
        .into_element()
}

/// Container `node`: a split of its children, or a tab group. A container
/// is one or the other for as long as its id lives.
pub(crate) fn node_view(a: AreaCx, node: NodeId) -> AnyElement {
    match untracked(|| a.area.with(|area| area.shape(node))) {
        Some(Shape::Split(_)) => split_view(a, node),
        Some(Shape::Tabs) => super::tab_group::tab_group(a, node),
        None => view().into_element(),
    }
}

/// One child of a split: its container, slot size and whether anything in
/// it shows.
#[derive(Clone, Debug, PartialEq)]
struct Slot {
    node: NodeId,
    size: Option<Points>,
    /// It takes the room the others leave.
    grows: bool,
    visible: bool,
}

fn split_view(a: AreaCx, node: NodeId) -> AnyElement {
    let axis = computed(move || match a.area.with(|area| area.shape(node)) {
        Some(Shape::Split(split)) => split.axis,
        _ => Axis::Horizontal,
    });
    let slots = computed(move || {
        let shape = a.area.with(|area| area.shape(node));
        let Some(Shape::Split(split)) = shape else {
            return Vec::new();
        };
        let mut slots: Vec<Slot> = split
            .children
            .iter()
            .zip(&split.sizes)
            .map(|(&child, &size)| Slot {
                node: child,
                size,
                grows: false,
                visible: a.area.with(|area| {
                    area.panels_under(child)
                        .iter()
                        .any(|panel| a.visible(panel))
                }),
            })
            .collect();
        // The last shown slot takes what the others leave, whatever its
        // size: with every slot sized, the split would end short of its
        // frame once that grows (`gpui-base`'s rule).
        if let Some(last) = slots.iter_mut().rev().find(|slot| slot.visible) {
            last.grows = true;
        }
        slots
    });
    let mut group = resizable_panel_group();
    // The app's style prop as it is (the setter takes typed styles).
    group.__element().__props_mut().handle_style = a.props.handle_style;
    group.__element().__props_mut().handle_thumb_style = a.props.handle_thumb_style;
    let group = group
        .axis(move || axis.get())
        .handle_class(a.props.handle_class)
        .handle_thumb_class(a.props.handle_thumb_class)
        .handle_accessibility_label(a.props.handle_accessibility_label)
        .on_resize(move |sizes: &Vec<Points>| {
            // The sizes of the visible children, in order: the hidden ones
            // keep theirs.
            let slots = slots.get_untracked();
            let mut sizes = sizes.iter();
            let next: Vec<Option<Points>> = slots
                .iter()
                .map(|slot| match slot.visible {
                    true => sizes.next().copied().or(slot.size),
                    false => slot.size,
                })
                .collect();
            a.edit(|area| area.set_split_sizes(node, next));
        })
        .child(each(
            move || slots.get(),
            |slot: &Slot| slot.node,
            move |slot, _| {
                let child = slot.get_untracked().node;
                resizable_panel()
                    .size(move || slot.with(|s| s.size.filter(|_| !s.grows)))
                    .visible(move || slot.get().visible)
                    .child(node_view(a, child))
            },
        ));
    group.into_element()
}

// --- Docks ------------------------------------------------------------------

/// The dock at `placement`, while the area has one: a frame as wide (or
/// tall) as the dock, its chrome and its layout, and the handle that
/// resizes it on the side facing the center. A closed dock takes no space
/// and stays placed, hidden, so its panels keep their state.
fn dock_frame(a: AreaCx, placement: DockPlacement) -> AnyElement {
    let has = computed(move || a.area.with(|area| area.dock(placement).is_some()));
    when(
        move || has.get(),
        move || {
            let info = computed(move || {
                a.area.with(|area| {
                    area.dock(placement).map(|pane| DockInfo {
                        placement,
                        open: pane.dock.is_open(),
                        size: pane.dock.size(),
                        collapsible: pane.dock.is_collapsible(),
                    })
                })
            });
            let size = move || match a.dock_drag.get() {
                Some(drag) if drag.placement == placement => {
                    shown_dock_size(a, placement, drag.raw)
                }
                _ => info
                    .get()
                    .map_or(Points::ZERO, |info| fit_dock(a, placement, info.size)),
            };
            let open = move || info.get().is_some_and(|info| info.open);
            let (axis, edge) = match placement {
                DockPlacement::Left => (Axis::Horizontal, HandleEdge::Trailing),
                DockPlacement::Right => (Axis::Horizontal, HandleEdge::Leading),
                _ => (Axis::Vertical, HandleEdge::Leading),
            };
            let sign = if placement == DockPlacement::Left {
                1.0
            } else {
                -1.0
            };
            view()
                .relative()
                // Its size, unless the area is too small for it and the
                // center's minimum: then it shrinks with the rest.
                .flex_grow(0.0)
                .flex_shrink(1.0)
                .min_w(px(0.0))
                .min_h(px(0.0))
                .flex_col()
                .overflow_hidden()
                .style_with(move |s| match placement {
                    DockPlacement::Bottom => s.h(size()),
                    _ => s.w(size()),
                })
                .style_when(move || !open(), |s| s.hidden())
                .app_class(a.props.dock_class)
                .inline_style(a.props.dock_style)
                .child(dynamic(move || {
                    let info = info.get()?;
                    a.props
                        .render_dock
                        .get()
                        .map(|r| r.render(dock_key(placement), info))
                }))
                .child(
                    view()
                        .flex_1()
                        .min_h(px(0.0))
                        .min_w(px(0.0))
                        .child(region(a, placement)),
                )
                .child(
                    {
                        let mut handle = resize_handle();
                        // The app's style prop as it is (the setter takes
                        // typed styles).
                        handle.__element().__props_mut().thumb_style = a.props.handle_thumb_style;
                        handle
                    }
                    .axis(axis)
                    .edge(edge)
                    .thumb_class(a.props.handle_thumb_class)
                    .accessibility_label(a.props.handle_accessibility_label)
                    .on_drag_start(move || {
                        let from = info.get_untracked().map_or(Points::ZERO, |i| i.size);
                        a.dock_drag.set(Some(DockDrag {
                            placement,
                            from,
                            raw: from,
                        }));
                    })
                    .on_drag_move(move |offset: &Points| {
                        a.dock_drag.update(|drag| {
                            if let Some(drag) = drag {
                                drag.raw = drag.from + *offset * sign;
                            }
                        });
                    })
                    .on_drag_end(move |offset: &Points| {
                        let Some(drag) = a.dock_drag.get_untracked() else {
                            return;
                        };
                        a.dock_drag.set(None);
                        end_dock_drag(a, placement, drag.from + *offset * sign);
                    })
                    .child(
                        // The indicator is the band's line, 1 point
                        // across (the band stretches it along): the
                        // app's class colors it, or makes it thicker.
                        view()
                            .map(|v| match axis {
                                Axis::Horizontal => v.w(HANDLE_SIZE),
                                Axis::Vertical => v.h(HANDLE_SIZE),
                            })
                            .app_class(a.props.handle_class)
                            .inline_style(a.props.handle_style),
                    ),
                )
        },
    )
    .into_element()
}

pub(crate) fn dock_key(placement: DockPlacement) -> &'static str {
    match placement {
        DockPlacement::Left => "left",
        DockPlacement::Right => "right",
        DockPlacement::Bottom => "bottom",
        DockPlacement::Center => "center",
    }
}

/// How big the dock at `placement` may be in this area (tracked).
fn dock_sizing(a: AreaCx, placement: DockPlacement) -> DockSizing {
    let size = a.size.get();
    let opposite = match placement {
        DockPlacement::Left => Some(DockPlacement::Right),
        DockPlacement::Right => Some(DockPlacement::Left),
        _ => None,
    };
    let opposite = opposite
        .and_then(|p| {
            a.area.with(|area| {
                area.dock(p)
                    .filter(|pane| pane.dock.is_open())
                    .map(|pane| pane.dock.size())
            })
        })
        .unwrap_or(Points::ZERO);
    DockSizing::new(placement)
        .with_area_width(size.width)
        .with_area_height(size.height)
        .with_opposite_dock_size(opposite)
}

/// The size the dock at `placement` shows at for its `size` (tracked):
/// within what the area leaves it (`DockSizing::clamp`, as `gpui-base`'s
/// area clamps it to its bounds), and never more than the area, once the
/// area is laid out.
fn fit_dock(a: AreaCx, placement: DockPlacement, size: Points) -> Points {
    let area = a.size.get();
    let across = match placement {
        DockPlacement::Bottom => area.height,
        _ => area.width,
    };
    if across <= Points::ZERO {
        return size;
    }
    dock_sizing(a, placement).clamp(size).min(across)
}

fn collapsible(a: AreaCx, placement: DockPlacement) -> bool {
    a.area.with_untracked(|area| {
        area.dock(placement)
            .is_some_and(|pane| pane.dock.is_collapsible())
    })
}

/// The size a dock shows while its handle is dragged to `raw`: within its
/// range, or (a collapsible one) following the pointer below its minimum,
/// towards closing.
fn shown_dock_size(a: AreaCx, placement: DockPlacement, raw: Points) -> Points {
    if raw < PANEL_MIN_SIZE && collapsible(a, placement) {
        return raw.max(Points::ZERO);
    }
    dock_sizing(a, placement).clamp(raw)
}

/// A drag of a dock's handle ended at `raw`: a collapsible dock let go
/// nearer closed than its minimum closes (keeping its size for when it
/// opens), otherwise it takes the size within its range.
fn end_dock_drag(a: AreaCx, placement: DockPlacement, raw: Points) {
    if collapsible(a, placement) && raw < PANEL_MIN_SIZE * 0.5 {
        a.edit(|area| area.set_dock_open(placement, false));
        return;
    }
    let size = dock_sizing(a, placement).clamp(raw);
    a.edit(|area| area.set_dock_size(placement, size));
}

// --- The drag preview -------------------------------------------------------

/// What follows the pointer while a tab is dragged: the app's
/// `renderDragPreview`, in an overlay at the pointer that takes no touches.
/// It moves by a transform, not its frame, so the drop indicator's layout
/// animation (`tab_group.rs`) leaves it at the pointer.
fn drag_preview(a: AreaCx) -> AnyElement {
    let shown = computed(move || {
        a.drag.with(|drag| drag.is_some()) && a.props.render_drag_preview.with(Option::is_some)
    });
    let dragged = computed(move || a.drag.with(|drag| drag.as_ref().map(|d| d.panel.clone())));
    let x = animated_value(0.0);
    let y = animated_value(0.0);
    effect(move || {
        if let Some(at) = a.drag.with(|drag| drag.as_ref().map(|d| d.pointer)) {
            x.set(at.x.0);
            y.set(at.y.0);
        }
    });
    when(
        move || shown.get(),
        move || {
            overlay()
                .pointer_events(PointerEvents::None)
                .focusable(false)
                .left(Points::ZERO)
                .top(Points::ZERO)
                .bind_translate_x(&x)
                .bind_translate_y(&y)
                .child(dynamic(move || {
                    let panel = dragged.get()?;
                    let tab = untracked(|| super::tab_group::tab_value(a, &panel))?;
                    a.props
                        .render_drag_preview
                        .get()
                        .map(|r| r.render("preview", tab))
                }))
        },
    )
    .into_element()
}
