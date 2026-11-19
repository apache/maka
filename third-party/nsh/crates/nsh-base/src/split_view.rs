//! `SplitView`: two or three columns side by side (a sidebar, an optional
//! content column and the detail), each one of the app's navigation stacks,
//! which show one at a time where the room is compact. Its look is the
//! app's; which columns show (`columnVisibility`) is the app's value too,
//! controlled as `Sheet`'s `open` is.
//!
//! # On iOS and Mac Catalyst
//!
//! The columns are a `UISplitViewController`'s, made by the backend for a
//! native component of NSH's own ([`SPLIT_VIEW_COMPONENT`]): its sidebar
//! floats over the content on iPadOS 26, comes in with a swipe from the
//! edge and shows with the system's button, and the system changes what
//! shows as the window turns or is resized. Each column is the
//! `UINavigationController` of the `NavStack` the app gives it, so its
//! pages keep the system header, swipe back and their state. Where the
//! window is horizontally compact the split collapses: its compact column
//! shows one navigation stack of the columns' pages in order (the sidebar's,
//! then the content's, then the detail's, as far as the visibility goes),
//! and the user goes back from a column's first page to the column before.
//!
//! The view this component renders there is the native component's, on top,
//! and before it one wrapper per column, in column order, which places the
//! column's slot (its `NavStack`). The backend finds each column's stack in
//! its wrapper (`crates/nsh-platform-ios/src/split.rs` walks them in that
//! order) and gives its navigation controller to the split; the wrappers
//! show nothing themselves. The core lays a stack's pages out at its size,
//! so each wrapper takes the size the split gives its column, which the
//! backend reports (`layout`).
//!
//! The component's props and events, as JSON:
//!
//! - `columns`: `"double"` or `"triple"` (with a content column).
//! - `columnVisibility`: the visibility to show
//!   ([`ColumnVisibility::name`]).
//! - `revision`: a number the component bumps to show `columnVisibility`
//!   again after the user changed what shows and the app kept its value.
//! - event `columnVisibilityChange`: the user or the system changed what
//!   shows (a name, never `"automatic"`).
//! - event `compactColumnChange`: in the collapsed split the user went back
//!   from a column's first page to column `n` (0 the sidebar), which is the
//!   one that shows now ([`ColumnVisibility::of_compact_column`]).
//! - event `layout`: `{ sidebar, content?, detail }`, each `{ width,
//!   height }`: the size of each column's stack.
//!
//! # Elsewhere
//!
//! The columns are a dock area's (`dock/`, the code `DockArea` runs, in this
//! component's view so the slots it places are its own): the sidebar is the
//! left dock and the content and the detail split the center, at fixed
//! widths ([`SIDEBAR_WIDTH`], [`CONTENT_WIDTH`]) that nothing resizes: no
//! handle at the sidebar's edge or between the columns, for a pointer or a
//! screen reader; nothing draws tabs. Where the window is horizontally compact
//! (`horizontal_size_class()`, below 600 points of its width, as UIKit
//! collapses a split by its size class) the area takes its compact
//! presentation: the center shows one column at a time, the first the
//! visibility shows, and every column stays placed, so a column's stack
//! keeps its pages and its state across both presentations. Deciding by the
//! size class on every platform lets the app read it for what a selection
//! does (`horizontalSizeClass()`).

use nsh_core::{
    JsonValue,
    element::{NativeEvent, Renderer, Style, StyleRefinement, native},
    geometry::{Bounds, Size},
    platform::{Os, SPLIT_VIEW_COMPONENT},
    prelude::*,
};

use crate::dock::{
    AreaCx, DockAreaLayout, DockAreaProps, DockLayout, DockNode, DockPanel, DockPanelOptions,
    DockPlacement, DockRegion, area_view,
};

/// The sidebar's width outside iOS (iPadOS's default for a split view's
/// primary column).
pub(crate) const SIDEBAR_WIDTH: Points = px(320.0);

/// The content column's width outside iOS (iPadOS's default for a split
/// view's supplementary column).
pub(crate) const CONTENT_WIDTH: Points = px(320.0);

/// The dock area's panel keys of the columns.
const SIDEBAR: &str = "sidebar";
const CONTENT: &str = "content";
const DETAIL: &str = "detail";

/// Which columns of a [`SplitView`] show (SwiftUI's
/// `NavigationSplitViewVisibility`). Where the room is compact one column
/// shows: the first of those this value shows, `automatic` the sidebar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum ColumnVisibility {
    /// The platform decides: on iPadOS by the window's size and
    /// orientation, keeping what the user shows; elsewhere every column.
    #[default]
    Automatic,
    /// Every column.
    All,
    /// The content and the detail, without the sidebar (with two columns,
    /// the same as `all`).
    DoubleColumn,
    /// The detail alone.
    DetailOnly,
}

impl ColumnVisibility {
    /// Its name in TypeScript and to the native split view.
    pub fn name(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::All => "all",
            Self::DoubleColumn => "doubleColumn",
            Self::DetailOnly => "detailOnly",
        }
    }

    /// The visibility named `name` ([`Self::name`]).
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "automatic" => Self::Automatic,
            "all" => Self::All,
            "doubleColumn" => Self::DoubleColumn,
            "detailOnly" => Self::DetailOnly,
            _ => return None,
        })
    }

    /// Whether the sidebar shows beside the others where there is room
    /// (outside iOS `automatic` shows every column).
    pub(crate) fn shows_sidebar(self, triple: bool) -> bool {
        match self {
            Self::Automatic | Self::All => true,
            Self::DoubleColumn => !triple,
            Self::DetailOnly => false,
        }
    }

    /// Whether the content column shows beside the detail where there is
    /// room.
    pub(crate) fn shows_content(self) -> bool {
        self != Self::DetailOnly
    }

    /// The column that shows where the room is compact (0 the sidebar, 1
    /// the content with three columns, the last the detail): the first this
    /// value shows, the sidebar for `automatic`.
    pub(crate) fn compact_column(self, triple: bool) -> usize {
        match self {
            Self::Automatic | Self::All => 0,
            Self::DoubleColumn => usize::from(triple),
            Self::DetailOnly => 1 + usize::from(triple),
        }
    }

    /// The visibility whose compact column is `column` (the one the user
    /// went back to).
    pub(crate) fn of_compact_column(column: usize, triple: bool) -> Self {
        match (column, triple) {
            (0, _) => Self::All,
            (1, true) => Self::DoubleColumn,
            _ => Self::DetailOnly,
        }
    }
}

/// The props of [`SplitView`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct SplitViewProps {
    /// Which columns show (controlled): the app owns the value and changes
    /// it in `onColumnVisibilityChange`. Without it the view keeps its
    /// own, starting from `automatic`.
    pub column_visibility: Prop<Option<ColumnVisibility>>,
    /// The first column: a `NavStack` of the app's sections or lists.
    pub sidebar: Prop<Option<Slot>>,
    /// The middle column of three, between the sidebar and the detail: a
    /// `NavStack`. Without it the view has two columns.
    pub content: Prop<Option<Slot>>,
    /// The last column, what the others select: a `NavStack`.
    pub detail: Prop<Option<Slot>>,
}

/// The events of a [`SplitView`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SplitViewEvent {
    /// The user or the system changed which columns show (iPadOS's
    /// sidebar button, a swipe from the edge, a turn of the window, going
    /// back from a column's first page where the room is compact): set
    /// `columnVisibility` to follow it. A controlled view shows its
    /// `columnVisibility` again when the app keeps another value (but
    /// `automatic`, which keeps what the user shows).
    #[args(column_visibility)]
    ColumnVisibilityChange(ColumnVisibility),
}

/// Two or three columns side by side (a sidebar, an optional content
/// column, the detail), each a `NavStack` of the app's, with no look of
/// their own: on iOS and Mac Catalyst a `UISplitViewController` whose
/// columns are those stacks (its sidebar floats on iPadOS 26, comes in with
/// a swipe from the edge and the system's button, and follows the window as
/// it turns or is resized), elsewhere columns at fixed widths. Where the
/// window is horizontally compact (a phone, a narrow window: its horizontal
/// size class, `horizontalSizeClass()`) one column shows: on iOS one
/// navigation stack of the columns' pages, which goes back from a column's
/// first page to the column before; elsewhere the column alone, the app
/// showing the way back. Which columns show is
/// `columnVisibility`, controlled, with `onColumnVisibilityChange`.
#[component]
pub fn SplitView(props: SplitViewProps, cx: Scope<SplitViewEvent>) -> impl IntoElement {
    let visibility = Visibility::new(props.column_visibility);
    let triple = computed(move || props.content.with(Option::is_some));
    // Its own size: what the columns fit in on iOS until the split says.
    let size = signal(Size::<Points>::default());
    let root = view()
        .relative()
        .flex_row()
        .overflow_hidden()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .on_layout(move |frame: &Bounds<Points>| size.set(frame.size));
    if os() == Os::Ios {
        return root
            .children(native_columns(props, cx, visibility, triple, size))
            .into_element();
    }
    root.child(dock_columns(props, visibility, triple).flex_1())
        .into_element()
}

// --- Which columns show -----------------------------------------------------

/// The visibility the view shows: the app's when it controls it, else its
/// own; and what makes the platform show it again.
#[derive(Clone, Copy)]
struct Visibility {
    controlled: Prop<Option<ColumnVisibility>>,
    own: Signal<ColumnVisibility>,
    /// Bumped to show the visibility again after the user changed what
    /// shows and the app kept its value.
    revision: Signal<u32>,
    /// The view's own owner, under which a change waits for the app's
    /// answer.
    owner: Owner,
}

impl Visibility {
    fn new(controlled: Prop<Option<ColumnVisibility>>) -> Self {
        Self {
            controlled,
            own: signal(ColumnVisibility::Automatic),
            revision: signal(0),
            owner: Owner::current(),
        }
    }

    /// The visibility to show (tracked).
    fn get(self) -> ColumnVisibility {
        self.controlled.get().unwrap_or_else(|| self.own.get())
    }

    fn get_untracked(self) -> ColumnVisibility {
        untracked(|| self.get())
    }

    /// The platform shows `next`, a change of the user's or the system's:
    /// reported, then kept when the view keeps its own; a controlled view
    /// shows the app's value again once the app has answered, unless the
    /// app took `next` or keeps `automatic` (the system's and the user's
    /// choice).
    fn changed(self, next: ColumnVisibility, report: impl FnOnce()) {
        let before = self.get_untracked();
        report();
        if before == ColumnVisibility::Automatic {
            return;
        }
        if self.controlled.get_untracked().is_none() {
            self.own.set(next);
            return;
        }
        let (controlled, revision) = (self.controlled, self.revision);
        self.owner.run(|| {
            after_answer(move || {
                let kept = controlled.get_untracked();
                if kept.is_some_and(|kept| kept != next && kept != ColumnVisibility::Automatic) {
                    revision.update(|r| *r = r.wrapping_add(1));
                }
            })
        });
    }
}

// --- iOS: UISplitViewController ---------------------------------------------

/// The columns on iOS: a wrapper per column placing its slot at the size
/// the split gives the column, under the native split view.
fn native_columns(
    props: SplitViewProps,
    cx: Scope<SplitViewEvent>,
    visibility: Visibility,
    triple: Memo<bool>,
    size: Signal<Size<Points>>,
) -> Vec<AnyElement> {
    // The size of each column's stack, as the split last reported it.
    let sizes = signal([None::<Size<Points>>; 3]);
    let wrapper = move |column: usize, slot: Prop<Option<Slot>>| {
        let shown = move || sizes.with(|s| s[column]).unwrap_or_else(|| size.get());
        view()
            .absolute()
            .left(px(0.0))
            .top(px(0.0))
            .w(move || shown().width)
            .h(move || shown().height)
            // The split shows the column: this only lays its stack out,
            // filling it (a grid of one cell, as a dock panel's place).
            .opacity(0.0)
            .pointer_events(PointerEvents::None)
            .grid()
            .grid_cols(1)
            .grid_rows(1)
            .child(slot.place(|slot| slot))
    };
    vec![
        wrapper(0, props.sidebar).into_element(),
        when(move || triple.get(), move || wrapper(1, props.content)).into_element(),
        wrapper(2, props.detail).into_element(),
        native(SPLIT_VIEW_COMPONENT)
            .absolute()
            .inset_0()
            .prop("columns", move || {
                JsonValue::from(if triple.get() { "triple" } else { "double" })
            })
            .prop("columnVisibility", move || {
                JsonValue::from(visibility.get().name())
            })
            .prop("revision", move || {
                JsonValue::from(visibility.revision.get())
            })
            .on_native_event(move |event: &NativeEvent| {
                let next = match &*event.name {
                    "columnVisibilityChange" => {
                        event.data.as_str().and_then(ColumnVisibility::from_name)
                    }
                    // Back from a column's first page in the collapsed
                    // split: the column the user went back to shows.
                    "compactColumnChange" => event.data.as_u64().map(|column| {
                        ColumnVisibility::of_compact_column(column as usize, triple.get_untracked())
                    }),
                    "layout" => {
                        sizes.set(column_sizes(&event.data));
                        None
                    }
                    _ => None,
                };
                if let Some(next) = next.filter(|&next| next != ColumnVisibility::Automatic) {
                    visibility.changed(next, || {
                        cx.emit(SplitViewEvent::ColumnVisibilityChange(next))
                    });
                }
            })
            .into_element(),
    ]
}

/// The columns' sizes in a `layout` event: `{ sidebar, content, detail }`,
/// each `{ width, height }` in points.
fn column_sizes(data: &JsonValue) -> [Option<Size<Points>>; 3] {
    let of = |key: &str| {
        let column = data.get(key)?;
        let width = column.get("width")?.as_f64()? as f32;
        let height = column.get("height")?.as_f64()? as f32;
        (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
            .then(|| Size::new(px(width), px(height)))
    };
    [of(SIDEBAR), of(CONTENT), of(DETAIL)]
}

// --- Elsewhere: the dock area ----------------------------------------------

/// The columns outside iOS: a dock area of fixed widths whose layout
/// follows the visibility, in this view (the slots it places are this
/// component's).
fn dock_columns(props: SplitViewProps, visibility: Visibility, triple: Memo<bool>) -> View {
    // As UIKit collapses a split: by the window's horizontal size class
    // (below 600 points of its width here), which the app reads too.
    let compact = computed(|| horizontal_size_class() == SizeClass::Compact);
    // The layouts' ids are made once for each number of columns, so a
    // change of what shows keeps every group of the area.
    let layouts = computed(move || Layouts::new(triple.get()));
    let layout =
        computed(move || layouts.with(|l| l.layout(triple.get(), visibility.get(), compact.get())));
    let panels = computed(move || {
        let content_shown = compact.get() || visibility.get().shows_content();
        vec![DockPanelOptions {
            visible: Some(content_shown),
            ..DockPanelOptions::new(CONTENT)
        }]
    });
    let render = Renderer::new(move |panel: &DockPanel| match panel.id.as_str() {
        SIDEBAR => props.sidebar.place(|slot| slot),
        CONTENT => props.content.place(|slot| slot),
        _ => props.detail.place(|slot| slot),
    });
    let area = DockAreaProps {
        layout: Prop::bind(move || Some(layout.get())),
        compact: Prop::bind(move || Some(compact.get())),
        locked: Prop::new(true),
        panels: Prop::from(panels),
        render_panel: Prop::new(Some(render)),
        // A column is not a tab: no tab bar shows.
        tab_bar_style: Prop::new(Style::from(StyleRefinement::default().hidden())),
        ..DockAreaProps::default()
    };
    // Nothing the user does in the area changes its layout: no tabs, no
    // handles (`resizable` off), no drawers.
    let a = AreaCx::new(area, |_| {}, false);
    area_view(a)
}

/// The dock area's two layouts for two or three columns, their ids made
/// once: the full one (the sidebar the left dock, the content and the
/// detail splitting the center) and the compact one (one tab group of
/// every column, the center showing one at a time).
#[derive(Clone, Debug, PartialEq)]
struct Layouts {
    regular: DockAreaLayout,
    compact: DockAreaLayout,
}

impl Layouts {
    fn new(triple: bool) -> Self {
        let center = match triple {
            true => DockLayout::h_split()
                .child(DockLayout::tabs().panel(CONTENT), Some(CONTENT_WIDTH))
                .child(DockLayout::tabs().panel(DETAIL), None),
            false => DockLayout::h_split().child(DockLayout::tabs().panel(DETAIL), None),
        };
        let mut sidebar = DockRegion::new(DockLayout::tabs().panel(SIDEBAR));
        sidebar.size = Some(SIDEBAR_WIDTH);
        sidebar.collapsible = Some(false);
        let regular = DockAreaLayout::new(center)
            .with_dock(DockPlacement::Left, sidebar)
            .normalized();
        let mut columns = DockLayout::tabs().panel(SIDEBAR);
        if triple {
            columns = columns.panel(CONTENT);
        }
        let compact = DockAreaLayout::new(DockLayout::h_split().child(columns.panel(DETAIL), None))
            .normalized();
        Self { regular, compact }
    }

    /// The layout showing `visibility`, compact or not.
    fn layout(&self, triple: bool, visibility: ColumnVisibility, compact: bool) -> DockAreaLayout {
        if compact {
            let mut layout = self.compact.clone();
            show_tab(&mut layout.center, visibility.compact_column(triple));
            return layout;
        }
        let mut layout = self.regular.clone();
        if let Some(sidebar) = layout.left.as_mut() {
            sidebar.open = Some(visibility.shows_sidebar(triple));
        }
        layout
    }
}

/// Shows tab `index` of the first tab group in `node`.
fn show_tab(node: &mut DockNode, index: usize) -> bool {
    match node {
        DockNode::Tabs {
            panels,
            active_index,
            ..
        } => {
            *active_index = index.min(panels.len().saturating_sub(1));
            true
        }
        DockNode::Split { children, .. } => children.iter_mut().any(|child| show_tab(child, index)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The panels each region of `layout` shows, in order: `(center, left
    /// dock and whether it is open)`.
    fn shown(layout: &DockAreaLayout) -> (Vec<(String, bool)>, Option<bool>) {
        fn walk(node: &DockNode, out: &mut Vec<(String, bool)>) {
            match node {
                DockNode::Tabs {
                    panels,
                    active_index,
                    ..
                } => out.extend(
                    panels
                        .iter()
                        .enumerate()
                        .map(|(i, p)| (p.to_string(), i == *active_index)),
                ),
                DockNode::Split { children, .. } => children.iter().for_each(|c| walk(c, out)),
            }
        }
        let mut center = Vec::new();
        walk(&layout.center, &mut center);
        (center, layout.left.as_ref().and_then(|left| left.open))
    }

    #[test]
    fn names_round_trip_and_match_the_typescript_union() {
        for visibility in [
            ColumnVisibility::Automatic,
            ColumnVisibility::All,
            ColumnVisibility::DoubleColumn,
            ColumnVisibility::DetailOnly,
        ] {
            assert_eq!(
                ColumnVisibility::from_name(visibility.name()),
                Some(visibility)
            );
            assert_eq!(PropEnum::js_name(&visibility), visibility.name());
        }
        assert_eq!(ColumnVisibility::from_name("sidebar"), None);
        assert_eq!(ColumnVisibility::default(), ColumnVisibility::Automatic);
    }

    #[test]
    fn the_compact_column_is_the_first_one_shown() {
        use ColumnVisibility::*;
        // Three columns: sidebar, content, detail.
        assert_eq!(Automatic.compact_column(true), 0);
        assert_eq!(All.compact_column(true), 0);
        assert_eq!(DoubleColumn.compact_column(true), 1);
        assert_eq!(DetailOnly.compact_column(true), 2);
        // Two: sidebar, detail; `doubleColumn` is `all`.
        assert_eq!(DoubleColumn.compact_column(false), 0);
        assert_eq!(DetailOnly.compact_column(false), 1);
        // Going back to a column shows the visibility whose column it is.
        for triple in [false, true] {
            for column in 0..2 + usize::from(triple) {
                assert_eq!(
                    ColumnVisibility::of_compact_column(column, triple).compact_column(triple),
                    column
                );
            }
        }
    }

    #[test]
    fn the_full_layout_docks_the_sidebar_and_splits_the_rest() {
        use ColumnVisibility::*;
        let layouts = Layouts::new(true);
        for (visibility, open) in [
            (Automatic, true),
            (All, true),
            (DoubleColumn, false),
            (DetailOnly, false),
        ] {
            let layout = layouts.layout(true, visibility, false);
            let (center, sidebar) = shown(&layout);
            assert_eq!(
                center,
                [("content".into(), true), ("detail".into(), true)],
                "{visibility:?}"
            );
            assert_eq!(sidebar, Some(open), "{visibility:?}");
            let left = layout.left.as_ref().expect("the sidebar's dock");
            assert_eq!(left.size, Some(SIDEBAR_WIDTH));
            assert_eq!(left.collapsible, Some(false));
        }
        // Two columns: `doubleColumn` keeps the sidebar.
        let layouts = Layouts::new(false);
        let (center, sidebar) = shown(&layouts.layout(false, DoubleColumn, false));
        assert_eq!(center, [("detail".into(), true)]);
        assert_eq!(sidebar, Some(true));
        assert_eq!(
            shown(&layouts.layout(false, DetailOnly, false)).1,
            Some(false)
        );
    }

    #[test]
    fn the_compact_layout_shows_one_column() {
        use ColumnVisibility::*;
        let layouts = Layouts::new(true);
        for (visibility, column) in [
            (Automatic, "sidebar"),
            (All, "sidebar"),
            (DoubleColumn, "content"),
            (DetailOnly, "detail"),
        ] {
            let layout = layouts.layout(true, visibility, true);
            let (center, sidebar) = shown(&layout);
            assert_eq!(sidebar, None, "no dock at compact width");
            let active: Vec<_> = center.iter().filter(|(_, a)| *a).map(|(p, _)| p).collect();
            assert_eq!(active, [column], "{visibility:?}");
            assert_eq!(center.len(), 3, "every column stays placed");
        }
        let layouts = Layouts::new(false);
        let (center, _) = shown(&layouts.layout(false, DetailOnly, true));
        assert_eq!(center, [("sidebar".into(), false), ("detail".into(), true)]);
    }

    #[test]
    fn a_change_of_what_shows_keeps_the_layouts_ids() {
        let layouts = Layouts::new(true);
        let ids = |layout: &DockAreaLayout| {
            fn walk(node: &DockNode, out: &mut Vec<Option<u64>>) {
                out.push(node.id().map(|id| id.as_u64()));
                if let DockNode::Split { children, .. } = node {
                    children.iter().for_each(|c| walk(c, out));
                }
            }
            let mut out = Vec::new();
            walk(&layout.center, &mut out);
            if let Some(left) = &layout.left {
                walk(&left.layout, &mut out);
            }
            out
        };
        let all = layouts.layout(true, ColumnVisibility::All, false);
        let detail = layouts.layout(true, ColumnVisibility::DetailOnly, false);
        assert!(ids(&all).iter().all(Option::is_some));
        assert_eq!(ids(&all), ids(&detail));
        let compact = layouts.layout(true, ColumnVisibility::All, true);
        assert_eq!(
            ids(&compact),
            ids(&layouts.layout(true, ColumnVisibility::DetailOnly, true))
        );
    }

    #[test]
    fn column_sizes_read_the_layout_event() {
        let sizes = column_sizes(&serde_json::json!({
            "sidebar": { "width": 320, "height": 800 },
            "detail": { "width": 704.5, "height": 800 },
            "content": { "width": 0, "height": 800 },
        }));
        assert_eq!(sizes[0], Some(Size::new(px(320.0), px(800.0))));
        assert_eq!(
            sizes[1], None,
            "a column not laid out keeps the view's size"
        );
        assert_eq!(sizes[2], Some(Size::new(px(704.5), px(800.0))));
    }
}
