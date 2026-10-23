//! Lists of a component's own rows ([`virtual_list`]): virtualized and
//! recycled like `List`, the rows rendered in Rust. The core binds the
//! cells itself (no JS), within the commit that needs them. The layout
//! methods both kinds of list share are [`ListLayout`], how they scroll
//! [`super::Scrollable`].

use std::{
    borrow::Cow,
    hash::{Hash, Hasher},
    ops::RangeInclusive,
    rc::Rc,
    time::Duration,
};

use super::{
    Accessible, AnyElement, Interactive, IntoReactive, Position, Reactive,
    element::{BoundListConfig, ElKind, ElNode, Element, IntoElement, IntoListener, ListConfig},
    events, when,
};
use crate::{
    CellSlot, EventKind, EventPayload, ListContentStyle, ListViewport, PayloadValue, Prop, Tag,
    Viewability, geometry::Points,
};

crate::static_reactive!(ListContentStyle: ListContentStyle);

/// How a list lays out its rows: [`super::ListElement`] (the app's rows)
/// and [`VirtualList`] (the component's).
pub trait ListLayout: Sized {
    #[doc(hidden)]
    fn config(&mut self) -> &mut ListConfig;

    #[doc(hidden)]
    fn bound_config(&mut self) -> &mut Vec<BoundListConfig>;

    /// Sets a field of the layout with `set`: once for a value, in a
    /// binding (a component that runs once) for a signal or a closure.
    #[doc(hidden)]
    fn layout<T: 'static>(
        mut self,
        value: impl IntoReactive<T>,
        set: impl Fn(&mut ListConfig, T) + 'static,
    ) -> Self {
        match value.into_reactive() {
            Reactive::Static(v) => set(self.config(), v),
            Reactive::Bound(f) => self.bound_config().push(Rc::new(move |c| set(c, f()))),
        }
        self
    }

    /// The size of rows not measured yet (default 50 points).
    fn estimated_item_size(self, size: impl IntoReactive<Points>) -> Self {
        self.layout(size, |c, size: Points| c.estimated = Some(size.0))
    }

    /// Rows side by side (vertical lists).
    fn columns(self, columns: impl IntoReactive<u32>) -> Self {
        self.layout(columns, |c, columns| c.columns = Some(columns.max(1)))
    }

    /// Scrolls horizontally.
    fn horizontal(mut self) -> Self {
        self.config().horizontal = Some(true);
        self
    }

    /// What the list scrolls in (TS: `viewport`): [`ListViewport::Parent`]
    /// lays it out at its full length and renders the rows near the
    /// viewport of the scroll view around it, which scrolls it with what
    /// else it holds (headers above the list, other lists); the default,
    /// [`ListViewport::Own`], is a scroll view of its own. Fixed when the
    /// list is made.
    fn viewport(mut self, viewport: ListViewport) -> Self {
        self.config().viewport = Some(viewport);
        self
    }

    /// Item 0 at the end (chats), starting scrolled to the end.
    fn inverted(mut self) -> Self {
        self.config().inverted = Some(true);
        self
    }

    /// Stays at the end of its content while it is within `threshold` of
    /// it, as the content grows or the viewport shrinks (a reply
    /// streaming into the last row, the keyboard showing); scrolled further
    /// up, what is visible stays where it is (TS:
    /// `maintainVisibleContentPosition={{ autoscrollToBottomThreshold }}`).
    /// For lists that are not [`Self::inverted`], which keep their distance
    /// from the end anyway.
    fn follow_end(self, threshold: impl IntoReactive<Points>) -> Self {
        self.layout(threshold, |c, threshold: Points| {
            c.follow_end = Some(threshold.0.max(0.0));
        })
    }

    /// Whether the scroll indicator shows (default yes).
    fn scrollbar(self, shows: impl IntoReactive<bool>) -> Self {
        self.layout(shows, |c, shows| c.scrollbar_visible = Some(shows))
    }

    /// Padding and gaps of the rows, as one resolved content layout.
    fn content_style(self, style: impl IntoReactive<ListContentStyle>) -> Self {
        self.layout(style, |c, style| c.content = Some(style))
    }

    /// Padding around the rows.
    fn content_padding(self, padding: impl IntoReactive<Points>) -> Self {
        self.layout(padding, |c, padding: Points| {
            content(c).padding = crate::EdgeInsets::all(padding);
        })
    }

    /// Horizontal padding around the rows.
    fn content_padding_x(self, padding: impl IntoReactive<Points>) -> Self {
        self.layout(padding, |c, padding: Points| {
            let p = &mut content(c).padding;
            (p.left, p.right) = (padding, padding);
        })
    }

    /// Vertical padding around the rows.
    fn content_padding_y(self, padding: impl IntoReactive<Points>) -> Self {
        self.layout(padding, |c, padding: Points| {
            let p = &mut content(c).padding;
            (p.top, p.bottom) = (padding, padding);
        })
    }

    /// Padding above the rows.
    fn content_padding_top(self, padding: impl IntoReactive<Points>) -> Self {
        self.layout(padding, |c, padding: Points| {
            content(c).padding.top = padding
        })
    }

    /// Padding below the rows.
    fn content_padding_bottom(self, padding: impl IntoReactive<Points>) -> Self {
        self.layout(padding, |c, padding: Points| {
            content(c).padding.bottom = padding
        })
    }

    /// Space between rows (columns in horizontal lists).
    fn row_gap(self, gap: impl IntoReactive<Points>) -> Self {
        self.layout(gap, |c, gap: Points| content(c).row_gap = gap)
    }

    /// Space between columns ([`Self::columns`]).
    fn column_gap(self, gap: impl IntoReactive<Points>) -> Self {
        self.layout(gap, |c, gap: Points| content(c).column_gap = gap)
    }
}

/// The content style of a list's layout, made when first set.
fn content(config: &mut ListConfig) -> &mut ListContentStyle {
    config.content.get_or_insert_default()
}

/// Renders the row at a position.
pub(crate) type RowFn = Rc<dyn Fn(Position) -> AnyElement>;

/// Renders the separator between two rows.
pub(crate) type SeparatorFn = Rc<dyn Fn() -> AnyElement>;

/// The rows' identities, hashed, read in a binding.
pub(crate) type KeysFn = Rc<dyn Fn() -> Rc<[u64]>>;

/// A list of the component's own rows, as a view makes it.
#[derive(Clone)]
pub(crate) struct VirtualListEl {
    pub(crate) config: ListConfig,
    /// How many rows: bound, a binding that updates the list in place.
    pub(crate) count: Reactive<u32>,
    pub(crate) row: RowFn,
    /// The rows' identities, for splices (rows keep their cells and sizes
    /// when rows are added or removed before them).
    pub(crate) keys: Option<KeysFn>,
    /// Between rows (after each row but the last; before it, inverted).
    pub(crate) separator: Option<SeparatorFn>,
    /// The row scrolled to before the first frame.
    pub(crate) initial_index: Option<u32>,
    /// How long rows stay viewable before they are reported.
    pub(crate) min_view_time: Option<Duration>,
}

/// A virtualized, recycling list of `count` rows rendered by `row`: only
/// the rows near the viewport exist. `row(at)` builds the row at `at`
/// (`at.index()`) from the component's data.
///
/// Each cell's content is made once: when the cell shows another row its
/// position changes, and only the bindings that read it run again
/// (`text(move || rows.with(|r| r[at.index()].name.clone()))`). `count`
/// can be a signal or a closure: the list grows and shrinks in place. Give
/// the rows' identities with [`VirtualList::keys`] when rows come and go
/// other than at the end.
pub fn virtual_list<R: IntoElement>(
    count: impl IntoReactive<usize>,
    row: impl Fn(Position) -> R + 'static,
) -> VirtualList {
    let count = count.into_reactive().map(|n| n as u32);
    let mut node = ElNode::new(Tag::List);
    node.kind = ElKind::VirtualList(Box::new(VirtualListEl {
        config: ListConfig::default(),
        count,
        row: Rc::new(move |at| row(at).into_element()),
        keys: None,
        separator: None,
        initial_index: None,
        min_view_time: None,
    }));
    VirtualList(node)
}

/// One of a list's own cells (header, footer, empty) holding `content`.
fn extra_cell(slot: CellSlot, key: &'static str, content: AnyElement) -> ElNode {
    let mut cell = ElNode::new(Tag::Cell);
    cell.key = Some(key.into());
    super::host::set(&mut cell, Prop::Slot(slot));
    cell.children.push(content.0);
    cell
}

/// A list of the component's own rows ([`virtual_list`]).
#[derive(Clone)]
pub struct VirtualList(ElNode);

impl VirtualList {
    fn list(&mut self) -> &mut VirtualListEl {
        match &mut self.0.kind {
            ElKind::VirtualList(list) => list,
            _ => unreachable!("a VirtualList is a virtual list"),
        }
    }

    /// One of the list's own cells (header, footer, empty), outside the
    /// recycling: made with the view, kept while the view has it.
    fn extra(mut self, slot: CellSlot, key: &'static str, content: AnyElement) -> Self {
        self.0
            .children
            .retain(|c| c.key.as_ref().is_none_or(|k| k.as_str() != key));
        self.0.children.push(extra_cell(slot, key, content));
        self
    }

    /// The rows' identities, in order (any hashable id per row), read in a
    /// binding:
    /// `.keys(move || rows.with(|r| r.iter().map(|r| r.id).collect::<Vec<_>>()))`.
    pub fn keys<K: Hash, I: IntoIterator<Item = K>>(
        mut self,
        keys: impl Fn() -> I + 'static,
    ) -> Self {
        self.list().keys = Some(Rc::new(move || {
            keys()
                .into_iter()
                .map(|k| {
                    let mut h = rustc_hash::FxHasher::default();
                    k.hash(&mut h);
                    h.finish()
                })
                .collect()
        }));
        self
    }

    /// Above the rows, scrolling with them (TS: `header`):
    /// part of this view, so its state and handlers are the
    /// component's, and it is never recycled.
    pub fn header(self, header: impl IntoElement) -> Self {
        self.extra(CellSlot::Header, "\0header", header.into_element())
    }

    /// Below the rows, scrolling with them (TS: `footer`).
    pub fn footer(self, footer: impl IntoElement) -> Self {
        self.extra(CellSlot::Footer, "\0footer", footer.into_element())
    }

    /// Shown instead of the rows while there are none (TS:
    /// `empty`).
    pub fn empty(mut self, empty: impl IntoElement) -> Self {
        let empty = empty.into_element();
        match self.list().count.clone() {
            Reactive::Static(0) => self.extra(CellSlot::Empty, "\0empty", empty),
            Reactive::Static(_) => self,
            // While the bound count is 0.
            Reactive::Bound(count) => {
                let cell = extra_cell(CellSlot::Empty, "\0empty", empty);
                let shown = when(move || count() == 0, move || AnyElement(cell.clone()));
                self.0.children.push(shown.into_element().0);
                self
            }
        }
    }

    /// Between rows (TS: `separator`): `separator()` renders
    /// one after each row but the last (before it in an inverted list), in
    /// the row's cell.
    pub fn separator<R: IntoElement>(mut self, separator: impl Fn() -> R + 'static) -> Self {
        self.list().separator = Some(Rc::new(move || separator().into_element()));
        self
    }

    /// These rows stick to the start while scrolled past, until the next one
    /// pushes them out (section headers; one column, not inverted; TS:
    /// `stickyHeaderIndices`).
    pub fn sticky_header_indices(mut self, indices: impl IntoIterator<Item = usize>) -> Self {
        let indices = indices.into_iter().map(|i| i as u32).collect();
        super::host::set(&mut self.0, Prop::StickyIndices(indices));
        self
    }

    /// The sticky rows stick this far from the start instead, as CSS
    /// `position: sticky`'s `top` (`.sticky_header_offset(px(56.0))` under a
    /// 56 pt translucent bar; the rows scroll under the space before them;
    /// TS: `stickyHeaderOffset`).
    pub fn sticky_header_offset(mut self, offset: Points) -> Self {
        super::host::set(&mut self.0, Prop::StickyOffset(offset));
        self
    }

    /// The sticky rows stick this animated value from the start instead,
    /// following it (below a header that moves, `header` the header's
    /// visible height; TS: `stickyHeaderOffset` set to an animated value).
    pub fn bind_sticky_header_offset(mut self, value: &impl super::Animated) -> Self {
        if let Some(node) = value.animated_node().live() {
            super::host::set(&mut self.0, Prop::StickyOffsetNode(Some(node.id())));
            self.0.attrs.bound.push(node);
        }
        self
    }

    /// Scrolls to row `index` before the first frame (TS:
    /// `initialScrollIndex`).
    pub fn initial_scroll_index(mut self, index: usize) -> Self {
        self.list().initial_index = Some(index as u32);
        self
    }

    /// When rows count as viewable for
    /// [`Self::on_viewable_items_change`] (TS: `viewabilityConfig`'s
    /// thresholds; without one, any visible pixel counts).
    pub fn viewability(mut self, config: Viewability) -> Self {
        super::host::set(&mut self.0, Prop::Viewability(config));
        self
    }

    /// Rows are reported viewable once they stayed so this long (TS:
    /// `viewabilityConfig.minimumViewTime`).
    pub fn minimum_view_time(mut self, time: Duration) -> Self {
        self.list().min_view_time = Some(time).filter(|t| !t.is_zero());
        self
    }

    /// The viewable rows changed (TS: `onViewableItemsChange`).
    pub fn on_viewable_items_change<M>(
        self,
        listener: impl IntoListener<ViewableItems, M>,
    ) -> Self {
        self.on(
            EventKind::ViewableItemsChange,
            events::typed(listener.into_listener(), viewable),
        )
    }

    /// Scrolled close to the end (load more).
    pub fn on_load_more<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::LoadMore,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// How close to the end [`Self::on_load_more`] fires, in viewports
    /// (default 1; TS: `loadMoreThreshold`).
    pub fn load_more_threshold(mut self, viewports: f32) -> Self {
        super::host::set(&mut self.0, Prop::LoadMoreThreshold(viewports));
        self
    }

    /// Scrolled close to the start, once the user or a scroll command
    /// moved the list (load what comes before the first row: the newer
    /// messages of a chat opened at an old one; TS: `onLoadMoreAtStart`).
    /// Fires once per approach, and again while the list stays near the
    /// start when the rows change.
    pub fn on_load_more_at_start<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::LoadMoreAtStart,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// How close to the start [`Self::on_load_more_at_start`] fires, in
    /// viewports (default 1; TS: `loadMoreAtStartThreshold`).
    pub fn load_more_at_start_threshold(mut self, viewports: f32) -> Self {
        super::host::set(&mut self.0, Prop::LoadMoreAtStartThreshold(viewports));
        self
    }

    /// This list as the rows of a component's `Items` prop named `name`
    /// ([`super::ComponentElement::items`]): the slot's node, laid out and
    /// styled by the component that places it.
    pub(crate) fn into_items(mut self, name: &'static str) -> ElNode {
        self.list().config = ListConfig::default();
        self.0.style = Default::default();
        self.0.key = Some(format!("slot:{name}").into());
        self.0.attrs.props.push(Prop::ComponentSlot(name.into()));
        self.0
    }
}

/// The rows a list shows ([`VirtualList::on_viewable_items_change`]), by
/// index, and the ones it showed at the report before.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ViewableItems {
    /// The first and last viewable row (`None`: none is).
    pub viewable: Option<(usize, usize)>,
    /// The same at the report before.
    pub previous: Option<(usize, usize)>,
}

impl ViewableItems {
    fn range(rows: Option<(usize, usize)>) -> RangeInclusive<usize> {
        match rows {
            Some((first, last)) => first..=last,
            #[allow(clippy::reversed_empty_ranges)]
            None => 1..=0,
        }
    }

    /// The viewable rows (TS: `viewableItems`).
    pub fn indices(&self) -> RangeInclusive<usize> {
        Self::range(self.viewable)
    }

    /// The rows that became viewable (`true`) or stopped being viewable
    /// (`false`) since the report before (TS: `changed`).
    pub fn changed(&self) -> impl Iterator<Item = (usize, bool)> + '_ {
        let (now, before) = (self.indices(), Self::range(self.previous));
        let came = now
            .clone()
            .filter(move |i| !before.contains(i))
            .map(|i| (i, true));
        let (now, before) = (self.indices(), Self::range(self.previous));
        let went = before.filter(move |i| !now.contains(i)).map(|i| (i, false));
        came.chain(went)
    }
}

/// The payload of a viewability report: `first`, `last`, `previousFirst`,
/// `previousLast` (-1: none).
pub(crate) fn viewable_payload(
    now: Option<(u32, u32)>,
    before: Option<(u32, u32)>,
) -> EventPayload {
    let n = |v: Option<u32>| PayloadValue::Number(v.map_or(-1.0, f64::from));
    EventPayload::Map(vec![
        ("first", n(now.map(|r| r.0))),
        ("last", n(now.map(|r| r.1))),
        ("previousFirst", n(before.map(|r| r.0))),
        ("previousLast", n(before.map(|r| r.1))),
    ])
}

/// The range in a viewability payload under `first` / `last` (or the
/// `previous…` keys).
pub(crate) fn viewable_range(p: &EventPayload, first: &str, last: &str) -> Option<(u32, u32)> {
    let EventPayload::Map(entries) = p else {
        return None;
    };
    let get = |key: &str| {
        entries.iter().find_map(|(k, v)| match v {
            PayloadValue::Number(n) if *k == key && *n >= 0.0 => Some(*n as u32),
            _ => None,
        })
    };
    Some((get(first)?, get(last)?))
}

fn viewable(p: &EventPayload) -> Option<Cow<'_, ViewableItems>> {
    let range = |first, last| viewable_range(p, first, last).map(|(f, l)| (f as usize, l as usize));
    Some(Cow::Owned(ViewableItems {
        viewable: range("first", "last"),
        previous: range("previousFirst", "previousLast"),
    }))
}

impl ListLayout for VirtualList {
    fn config(&mut self) -> &mut ListConfig {
        &mut self.list().config
    }

    fn bound_config(&mut self) -> &mut Vec<BoundListConfig> {
        &mut self.0.bound_list
    }
}

impl Element for VirtualList {
    fn node(&mut self) -> &mut ElNode {
        &mut self.0
    }
}

impl IntoElement for VirtualList {
    fn into_element(self) -> AnyElement {
        AnyElement(self.0)
    }
}

impl Accessible for VirtualList {}
impl Interactive for VirtualList {}
impl super::Scrollable for VirtualList {}

/// How the rows changed from `old` to `new` keys: `(at, removed,
/// inserted)` by the common start and end (as `List` does), `None` when
/// they are the same.
pub(crate) fn splice(old: &[u64], new: &[u64]) -> Option<(u32, u32, u32)> {
    let max = old.len().min(new.len());
    let start = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let end = old[start..]
        .iter()
        .rev()
        .zip(new[start..].iter().rev())
        .take(max - start)
        .take_while(|(a, b)| a == b)
        .count();
    let removed = old.len() - start - end;
    let inserted = new.len() - start - end;
    (removed > 0 || inserted > 0).then_some((start as u32, removed as u32, inserted as u32))
}

#[cfg(test)]
mod tests {
    use super::ViewableItems;

    #[test]
    fn viewable_rows_report_what_changed() {
        let report = ViewableItems {
            viewable: Some((3, 6)),
            previous: Some((1, 4)),
        };
        assert_eq!(report.indices(), 3..=6);
        let changed: Vec<_> = report.changed().collect();
        assert_eq!(changed, [(5, true), (6, true), (1, false), (2, false)]);
        let none = ViewableItems {
            viewable: None,
            previous: Some((0, 1)),
        };
        assert_eq!(none.indices().count(), 0);
        assert_eq!(none.changed().collect::<Vec<_>>(), [(0, false), (1, false)]);
    }

    #[test]
    fn splices_keep_the_common_ends() {
        use super::splice;
        assert_eq!(splice(&[1, 2, 3], &[1, 2, 3]), None);
        assert_eq!(splice(&[1, 2, 3], &[0, 1, 2, 3]), Some((0, 0, 1)));
        assert_eq!(splice(&[1, 2, 3], &[1, 3]), Some((1, 1, 0)));
        assert_eq!(splice(&[1, 2, 3], &[1, 2, 3, 4]), Some((3, 0, 1)));
        assert_eq!(splice(&[1, 1], &[1]), Some((1, 1, 0)));
    }
}
