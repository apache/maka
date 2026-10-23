//! Virtualized list state: item sizes, offsets, the render window and cell
//! recycling. Pure bookkeeping; the core feeds it measurements and scroll
//! offsets and applies its decisions to the tree.
//!
//! Positions are computed along the list's main axis in *natural*
//! coordinates (distance from the start of the content: padding, header,
//! items, footer). An inverted list lays the same content out from the end
//! of the scroll view (item 0 at the bottom) and keeps its distance from
//! the end while content changes, like React Native's inverted lists.
//!
//! # Binding cells
//!
//! The window (Fenwick prefix sums over rows) renders one extra screen above
//! and below the viewport. The core asks JS to bind cells with
//! `__nsh_list(listId, [slot, index, …])`; JS updates a cell's content inside
//! `batch` and then sets its `cellIndex` to confirm, and only confirmed cells
//! are measured and positioned. New cells are created with their first
//! index. The engine runs at most 8 "bind → JS → layout" rounds per frame,
//! merged into one batch.
//!
//! A slot remembers the item JS was last asked to show (`requested`), so
//! what is still to bind is always derived from the current assignment:
//! nothing stale is queued. Cells whose item moved (a splice) learn their
//! new index in the same commit, and so does every cell in the viewport and
//! just ahead of it in the scroll direction. A list with `paced` set (the
//! runtime's) leaves the rest of the overscan pending: the engine binds it
//! with `take_paced`, nearest the leading edge first, as its per-turn
//! budget allows, and asks for a display frame while some is left.
//!
//! Row-local state travels with recycled cells, so
//! apps keep it outside, keyed by id. Unbound cells keep their last content:
//! the core moves them out of sight (never with a NaN frame; cells never
//! placed are skipped). The header, footer and empty placeholder are cells
//! with a role (`slot="header"`, ...) and are never recycled. Each cell is a
//! Taffy root of its own (its width follows the list's cross axis), so
//! scrolling relays out dirty cells only.
//!
//! # Scroll commands
//!
//! `scrollToEnd` / `scrollToIndex` resolve with estimated sizes for rows
//! never rendered, so the first offset is off. Their target stays pinned:
//! after each round of measurements the list follows it (`follow_pin`),
//! retargeting an animated scroll in flight, until the rows in the
//! viewport are measured, the user scrolls away or the items change.
//!
//! # In its parent's viewport
//!
//! A list with `viewport="parent"` has no scroll view of its own: it lies in
//! its parent's layout at its full length (a layout-only Taffy child, the
//! spacer, is `content_len` long) and is virtualized against the nearest
//! scroll view around it on its axis, or the root view it is in
//! ([`Outer`]). The core feeds the state that view's offset less the
//! list's start in its content (negative while the list starts below the
//! viewport's start) and that view's viewport, so the window, `onLoadMore`
//! and viewability work in the list's coordinates as they do for a list
//! of its own. The scroll view moves only for changes wholly above the top
//! of its viewport, as a browser's scroll anchoring does: rows measured or
//! spliced above the first visible row while the list's start is scrolled
//! past. Inverted lists and `maintainVisibleContentPosition` need a scroll
//! view of their own and are off. Sticky rows stick to the view's viewport:
//! their ranges are in its offsets, and the last one stops at the end of
//! the list's content, as CSS `position: sticky` stops at its container's.

use std::{cell::Cell, rc::Rc};

use rustc_hash::FxHashMap;

use crate::{
    fenwick::Fenwick,
    ops::{CellSlot, ListContentStyle, Viewability},
    text_source::{SourceGeometry, SourcePoint, SourcePosition},
};

/// How far beyond the viewport cells are kept rendered, in viewports.
const OVERSCAN: f32 = 1.0;
/// Default `loadMoreThreshold`, in viewports.
const END_THRESHOLD: f32 = 1.0;
/// Default `loadMoreAtStartThreshold`, in viewports.
const START_THRESHOLD: f32 = 1.0;

/// Which of a list's load-more events a window update raises
/// ([`ListState::update_window`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct Edges {
    /// `onLoadMore`: the end came near.
    pub(super) end: bool,
    /// `onLoadMoreAtStart`: the start came near.
    pub(super) start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeCell {
    Detached,
    Mounted,
    Retiring(u64),
}

#[derive(Debug, Clone, Copy)]
pub(super) enum NativeCellOp {
    Retire { cell: u32, request: u64 },
    Attach { cell: u32 },
}

/// A recycling slot: one cell node, bound to at most one item.
#[derive(Debug, Clone, Copy)]
pub(super) struct Slot {
    /// Cell node key (`u32::MAX` until the runtime created the cell).
    pub(super) cell: u32,
    /// Item this slot is assigned to.
    pub(super) index: Option<u32>,
    /// Item the cell's content currently shows (confirmed by the runtime).
    pub(super) rendered: Option<u32>,
    /// Item the runtime was last asked to show in this slot (its cell's
    /// index); `None` before the first request or when that item is gone.
    pub(super) requested: Option<u32>,
    native: NativeCell,
}

impl Slot {
    /// True when the cell shows its assigned item, so its size and
    /// position belong to that item.
    pub(super) fn ready(&self) -> Option<u32> {
        match (self.index, self.rendered) {
            (Some(i), Some(r)) if i == r && self.cell != u32::MAX => Some(i),
            _ => None,
        }
    }
}

/// A non-recycled cell: the header, footer or empty placeholder.
#[derive(Debug, Clone, Copy)]
pub(super) struct Extra {
    /// Cell node key, or `u32::MAX`.
    pub(super) cell: u32,
    /// Measured main-axis size (0 until measured).
    pub(super) size: f32,
}

impl Extra {
    const NONE: Self = Self {
        cell: u32::MAX,
        size: 0.0,
    };

    fn present(&self) -> bool {
        self.cell != u32::MAX
    }
}

/// Which extra cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExtraKind {
    Header = 0,
    Footer = 1,
    Empty = 2,
}

/// Where the blocks of a list's content start, in natural coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Blocks {
    pub(super) header: f32,
    /// The first item row (or the empty placeholder).
    pub(super) body: f32,
    pub(super) footer: f32,
    /// Content length: everything plus the end padding.
    pub(super) total: f32,
}

/// A scroll the core asked the platform for, not yet reflected in the
/// offsets it reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum PendingScroll {
    By(f32),
    To(f32),
}

/// Where the platform's reported `offset` ends up once the `pending`
/// scrolls (issued, not applied yet) are applied.
pub(super) fn replay(offset: f32, pending: &[(u32, PendingScroll)]) -> f32 {
    let mut at = offset;
    for &(_, scroll) in pending {
        match scroll {
            PendingScroll::By(d) => at += d,
            PendingScroll::To(t) => at = t,
        }
    }
    at
}

/// The view a `viewport="parent"` list is virtualized against: the
/// nearest scroll view around it on its axis, or the root view it is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Outer {
    /// The view's node key.
    pub(super) view: u32,
    /// It scrolls (a scroll view or a list); a root view does not.
    pub(super) scrolls: bool,
    /// Views between the list and it: lists nearer theirs are updated
    /// first, so a list in a cell of another sees the cell placed.
    pub(super) depth: u32,
}

/// What parent mode turns off ([`ListState::set_parent`]), kept to give
/// back.
#[derive(Debug)]
struct SetAside {
    inverted: bool,
    follow_end: Option<f32>,
}

/// Props a list in its parent's viewport ignores, each warned of once.
pub(super) mod ignored {
    pub(crate) const INVERTED: u16 = 1 << 0;
    pub(crate) const FOLLOW_END: u16 = 1 << 1;
    pub(crate) const ON_SCROLL: u16 = 1 << 3;
    pub(crate) const SCROLL_VALUE: u16 = 1 << 4;
    pub(crate) const REFRESH: u16 = 1 << 5;
    pub(crate) const BEHAVIOR: u16 = 1 << 6;
    pub(crate) const SCROLLBAR: u16 = 1 << 7;
    /// `viewport` changed after the list was made.
    pub(crate) const VIEWPORT: u16 = 1 << 8;
}

/// What a list scroll command asked to show: kept after the command, so
/// the offset follows the target while the cells around it are measured
/// (estimated sizes put the first offset off).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum PinTarget {
    /// `scrollToEnd`.
    End,
    /// `scrollToIndex`.
    Index {
        index: u32,
        view_position: f32,
        view_offset: f32,
    },
}

/// A pinned scroll target and the offset the list was last sent to for
/// it.
#[derive(Debug, Clone)]
enum Pin {
    Reading {
        point: SourcePoint,
        /// The shaped line's position in the viewport, including partial lines.
        line: f32,
        /// The expected offset, including corrections not yet reported applied.
        at: f32,
    },
    WaitingForIdle {
        target: PinTarget,
        animated: bool,
    },
    Following {
        target: PinTarget,
        at: f32,
        /// An animated scroll the platform has not finished: the pin follows
        /// by retargeting it, and the user moving away is only noticed once
        /// it landed.
        animating: bool,
        automatic: bool,
    },
}

/// How a pinned list follows its target (`ListState::follow_pin`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Follow {
    /// Already there.
    Stay,
    /// Scroll by this much now (with the anchoring `ScrollBy`).
    By(f32),
    /// Start or retarget a scroll to this offset.
    To { offset: f32, animated: bool },
}

/// How far a reported offset may be from a pinned one and still count as
/// the same (platforms round offsets to pixels).
const PIN_SLACK: f32 = 1.0;

/// A sticky cell's range of travel, as scroll offsets along the main axis:
/// from `start` it moves with the scroll offset, as far as `end` (by
/// `clamp(offset - start, 0, end - start)` from where the cell is laid out;
/// without a sticky offset, `start` is that position).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct StickyRange {
    pub(super) cell: u32,
    pub(super) start: f32,
    pub(super) end: f32,
    /// An animated value it sticks further from the viewport's start by.
    pub(super) offset: Option<crate::animation::NodeId>,
}

#[derive(Debug)]
pub(super) struct ListState {
    pub(super) count: u32,
    estimated: f32,
    /// Items per row (`numColumns`).
    pub(super) columns: u32,
    /// Measured main-axis sizes of items; NaN = not measured yet.
    sizes: Vec<f32>,
    /// Row sizes (the largest item of each row) plus the gap after the row.
    rows: Fenwick,
    pub(super) slots: Vec<Slot>,
    by_index: FxHashMap<u32, u32>,
    free: Vec<u32>,
    /// The native focus path's cell, not another focus authority. Its logical
    /// assignment survives scrolls and moves with ordinary source splices.
    focused: Option<u32>,
    retirement_requests: Rc<Cell<u64>>,
    pub(super) native_ops: Vec<NativeCellOp>,
    pub(super) extras: [Extra; 3],
    /// Padding and gaps: `contentStyle`, else `contentClass`'s.
    pub(super) content: ListContentStyle,
    /// `contentStyle` as set.
    content_style: ListContentStyle,
    /// What `contentClass` sets.
    content_class: ListContentStyle,
    pub(super) horizontal: bool,
    pub(super) inverted: bool,
    /// `maintainVisibleContentPosition`'s `autoscrollToBottomThreshold`:
    /// a list that is not inverted follows the end of its content while
    /// it is within this distance of it.
    pub(super) follow_end: Option<f32>,
    /// `stickyHeaderIndices`, sorted.
    pub(super) sticky: Vec<u32>,
    /// `stickyHeaderOffset`: sticky items stick this far from the
    /// viewport's start.
    sticky_offset: f32,
    /// `stickyHeaderOffset` as an animated value: added to `sticky_offset`
    /// by the platforms as they pin (a header that moves).
    sticky_node: Option<crate::animation::NodeId>,
    /// Sticky ranges last sent to the platform.
    pub(super) sent_sticky: Vec<StickyRange>,
    /// Ready cells attached to the native list, in content order with a
    /// parent-viewport list's sticky cells on top.
    /// Node ids, not reusable shadow-tree keys; JS keeps owning every cell.
    pub(super) mounted_cells: Vec<crate::NodeId>,
    pub(super) viewability: Viewability,
    /// Last reported viewable items (`first..=last`).
    pub(super) viewable: Option<(u32, u32)>,
    /// `loadMoreThreshold`, in viewports.
    pub(super) end_threshold: f32,
    /// `loadMoreAtStartThreshold`, in viewports.
    pub(super) start_threshold: f32,
    /// Main-axis scroll offset reported by the platform (content
    /// coordinates).
    pub(super) offset: f32,
    /// Main-axis size of the list viewport (from layout).
    pub(super) viewport: f32,
    /// Window, bindings or positions need recomputing.
    pub(super) dirty: bool,
    /// Cross-axis size the cells were last laid out at.
    pub(super) cells_cross: f32,
    load_more_at: Option<u32>,
    /// The count `onLoadMoreAtStart` last fired at while the viewport has
    /// stayed near the start; cleared when it leaves.
    load_more_at_start: Option<u32>,
    /// The list listens to `onLoadMoreAtStart`: an inverted one keeps its
    /// visible rows in place when scrolled away from its start, so the
    /// pages it loads there arrive out of sight (`keeps_visible_rows`).
    pub(super) loads_at_start: bool,
    /// The user or a scroll command moved the list: until then the start
    /// it opens at is not an approach (`onLoadMoreAtStart`).
    moved_by_scroll: bool,
    /// `content_len - viewport` when the offset was last anchored
    /// (inverted lists and `follow_end`; NaN before the first layout).
    anchored_end: f32,
    /// Scrolls issued to the platform (`ScrollBy` items and `ScrollTo`
    /// commands); platforms count the ones they applied.
    issued: u32,
    /// Issued scrolls by number, oldest first, until a report shows them
    /// applied.
    pending: Vec<(u32, PendingScroll)>,
    /// Cells whose item moved to another index (a splice): the runtime
    /// learns their new index with the next bindings.
    moved: Vec<(u32, u32)>,
    /// Binds of overscan cells wait for the engine's budget
    /// ([`Self::take_paced`]); the rest bind with the window.
    pub(super) paced: bool,
    /// The last scroll step the platform reported, in natural coordinates
    /// (its sign is the scroll direction). The core's own moves (anchoring
    /// a splice, measured rows, following a pin) are not steps.
    lead: f32,
    /// Scroll that keeps the visible content in place after a splice.
    splice_anchor: f32,
    /// The target of the last scroll command, until it is reached with
    /// measured cells or the user scrolls away.
    pin: Option<Pin>,
    /// Derived only when rendered source geometry or cell placement changes.
    pub(super) source_geometry: SourceGeometry,
    /// Source addressing of the current native projection, including unbound rows.
    pub(super) source_rows: Option<std::sync::Arc<crate::ListSourceRows>>,
    pub(super) source_dirty: bool,
    /// Native interaction tracking stays enabled after an automatic request.
    pub(super) automatic: bool,
    /// A direct native snapshot, unknown until the initial TrackStates report.
    interaction: Option<u8>,
    /// `viewport="parent"`: virtualized against the view around it.
    pub(super) parent: bool,
    /// The parent mode's view, once found.
    pub(super) outer: Option<Outer>,
    /// Parent mode: where the list's content starts in its view's content
    /// (NaN until placed).
    outer_start: f32,
    /// Parent mode: the list offsets its view can scroll to.
    limits: (f32, f32),
    /// Parent mode: the spacer that gives the list its length in layout,
    /// and the length it was given.
    pub(super) spacer: Option<(taffy::NodeId, f32)>,
    /// What parent mode turned off (`inverted`, `follow_end`), given back
    /// if the list goes back to its own scroll view before it is made.
    set_aside: Option<Box<SetAside>>,
    /// Ignored props set ([`ignored`] bits), and those already warned of.
    pub(super) ignored: u16,
    pub(super) warned: u16,
}

impl ListState {
    pub(super) fn new(retirement_requests: Rc<Cell<u64>>) -> Self {
        Self {
            count: 0,
            estimated: 50.0,
            columns: 1,
            sizes: Vec::new(),
            rows: Fenwick::default(),
            slots: Vec::new(),
            by_index: FxHashMap::default(),
            free: Vec::new(),
            focused: None,
            retirement_requests,
            native_ops: Vec::new(),
            extras: [Extra::NONE; 3],
            content: ListContentStyle::default(),
            content_style: ListContentStyle::default(),
            content_class: ListContentStyle::default(),
            horizontal: false,
            inverted: false,
            follow_end: None,
            sticky: Vec::new(),
            sticky_offset: 0.0,
            sticky_node: None,
            sent_sticky: Vec::new(),
            mounted_cells: Vec::new(),
            viewability: Viewability::default(),
            viewable: None,
            end_threshold: END_THRESHOLD,
            start_threshold: START_THRESHOLD,
            offset: 0.0,
            viewport: 0.0,
            dirty: true,
            cells_cross: f32::NAN,
            load_more_at: None,
            load_more_at_start: None,
            loads_at_start: false,
            moved_by_scroll: false,
            anchored_end: f32::NAN,
            issued: 0,
            pending: Vec::new(),
            moved: Vec::new(),
            paced: false,
            lead: 0.0,
            splice_anchor: 0.0,
            pin: None,
            source_geometry: SourceGeometry::default(),
            source_rows: None,
            source_dirty: false,
            automatic: false,
            interaction: None,
            parent: false,
            outer: None,
            outer_start: f32::NAN,
            limits: (0.0, 0.0),
            spacer: None,
            set_aside: None,
            ignored: 0,
            warned: 0,
        }
    }

    /// Switches to (or from) virtualizing against the view around the
    /// list. What needs a scroll view of its own is turned off and noted
    /// as ignored.
    pub(super) fn set_parent(&mut self, parent: bool) {
        if parent == self.parent {
            return;
        }
        self.parent = parent;
        self.outer = None;
        self.outer_start = f32::NAN;
        self.pin = None;
        self.dirty = true;
        self.anchored_end = f32::NAN;
        if parent {
            let set_aside = SetAside {
                inverted: std::mem::take(&mut self.inverted),
                follow_end: self.follow_end.take(),
            };
            if set_aside.inverted {
                self.ignored |= ignored::INVERTED;
            }
            if set_aside.follow_end.is_some() {
                self.ignored |= ignored::FOLLOW_END;
            }
            self.set_aside = Some(Box::new(set_aside));
        } else if let Some(set_aside) = self.set_aside.take() {
            let SetAside {
                inverted,
                follow_end,
            } = *set_aside;
            self.inverted = inverted;
            self.follow_end = follow_end;
        }
    }

    /// Parent mode: the list starts at `start` of its view's content, the
    /// view is at `offset` with a viewport of `viewport`, and scrolls as
    /// far as `max`; `settled`: none of the scrolls the core issued to it
    /// is pending. Returns whether the list's window moved.
    pub(super) fn set_outer(
        &mut self,
        start: f32,
        offset: f32,
        viewport: f32,
        max: f32,
        settled: bool,
    ) -> bool {
        let shift = start - self.outer_start;
        if shift != 0.0
            && !shift.is_nan()
            && let Some(Pin::Following { at, .. } | Pin::Reading { at, .. }) = &mut self.pin
        {
            // What moved the list in its view is no scroll of the user's.
            *at -= shift;
        }
        self.outer_start = start;
        self.limits = (-start, (max - start).max(-start));
        let resized = viewport != self.viewport;
        self.viewport = viewport;
        let before = self.offset;
        self.moved_to(offset - start, settled);
        resized || before != self.offset
    }

    /// `offset` within the offsets the list can be scrolled to.
    pub(super) fn clamped(&self, offset: f32) -> f32 {
        let (min, max) = self.offset_limits();
        offset.clamp(min, max)
    }

    /// The offsets the list can be scrolled to: its own content's, or in
    /// parent mode its view's, in the list's coordinates.
    fn offset_limits(&self) -> (f32, f32) {
        if self.parent {
            self.limits
        } else {
            (0.0, (self.content_len() - self.viewport).max(0.0))
        }
    }

    /// The items changed: `removed` items at `at` were replaced by
    /// `inserted` new ones. Measurements and cells follow the items that
    /// stay, and when the change is above the first visible item the
    /// visible content keeps its place.
    pub(super) fn splice(&mut self, at: u32, removed: u32, inserted: u32) -> Vec<u32> {
        let at = at.min(self.count);
        let removed = removed.min(self.count - at);
        if removed == 0 && inserted == 0 {
            return Vec::new();
        }
        // The visible content keeps its place instead.
        if !matches!(self.pin, Some(Pin::Reading { .. })) {
            self.pin = None;
        }
        self.source_dirty |= !self.source_geometry.is_empty();
        // The first visible item and where it is in the viewport. An
        // inverted list at its start (item 0 in view at the bottom) keeps
        // its distance from the end instead, so what arrives there shows.
        // In its parent's viewport, only while the list's start is scrolled
        // past (when it shows, the content below it moves instead).
        let anchor = (self.count > 0
            && self.viewport > 0.0
            && self.keeps_visible_rows()
            && (!self.parent || self.offset > 0.0))
            .then(|| {
                let top = self.natural_offset();
                let body = self.blocks().body;
                let row = self.rows.find((top - body).max(0.0) as f64) as u32;
                let index = (row * self.columns).min(self.count - 1);
                (index, self.item_at(index) - top)
            });
        let natural_before = self.natural_offset();
        let end = (at + removed) as usize;
        self.sizes.splice(
            at as usize..end,
            std::iter::repeat_n(f32::NAN, inserted as usize),
        );
        self.count = self.count - removed + inserted;
        let shift = |i: u32| -> Option<u32> {
            if i < at {
                Some(i)
            } else if i >= at + removed {
                Some(i - removed + inserted)
            } else {
                None
            }
        };
        let deleted: Vec<_> = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(slot, state)| {
                state
                    .index
                    .filter(|&index| index >= at && index < at + removed)
                    .map(|_| slot as u32)
            })
            .collect();
        let mut revoked = Vec::new();
        for slot in deleted {
            self.revoke_source(slot, &mut revoked);
        }
        self.by_index.clear();
        for (slot, s) in self.slots.iter_mut().enumerate() {
            let Some(new) = s.index.and_then(shift) else {
                continue;
            };
            if matches!(s.native, NativeCell::Retiring(_)) {
                s.native = NativeCell::Mounted;
                self.native_ops.push(NativeCellOp::Attach { cell: s.cell });
            }
            s.index = Some(new);
            s.rendered = s.rendered.and_then(shift);
            // The runtime's index for the cell follows its item at once, or
            // its content shows the item now at the old index.
            match s.requested.map(|r| (r, shift(r))) {
                Some((r, Some(n))) => {
                    s.requested = Some(n);
                    if n != r {
                        self.moved.push((slot as u32, n));
                    }
                }
                Some((_, None)) => {
                    s.requested = None;
                    s.rendered = None;
                }
                None => {}
            }
            self.by_index.insert(new, slot as u32);
        }
        self.free.sort_unstable();
        self.free.dedup();
        self.rebuild_offsets();
        if self.load_more_at.is_some() {
            self.load_more_at = None;
        }
        if let Some((index, from_top)) = anchor
            && index >= at + removed
        {
            let moved_to = index - removed + inserted;
            if self.inverted {
                // `anchor_end` restores the natural offset the list had;
                // the visible rows need it moved by as much as they did.
                let delta = (self.item_at(moved_to) - from_top).max(0.0) - natural_before;
                self.offset -= delta;
                self.splice_anchor -= delta;
            } else {
                let delta = self.item_at(moved_to) - from_top - self.natural_offset();
                self.compensate_layout_offset(delta);
                self.splice_anchor += delta;
            }
        }
        revoked
    }

    /// Whether changes before the viewport keep the visible rows in place:
    /// always for lists that are not inverted. Inverted ones keep their
    /// distance from the end (the bottom), unless they load at their start
    /// (`onLoadMoreAtStart`, which opts in) and are laid out and scrolled
    /// away from it: at the start they keep showing item 0 (a chat's newest
    /// message).
    fn keeps_visible_rows(&self) -> bool {
        !self.inverted
            || (self.loads_at_start
                && !self.anchored_end.is_nan()
                && self.natural_offset() > PIN_SLACK)
    }

    /// The scroll a splice asked for, once.
    pub(super) fn take_splice_anchor(&mut self) -> f32 {
        std::mem::take(&mut self.splice_anchor)
    }

    /// Records a `ScrollBy` sent to the platform.
    pub(super) fn issue_scroll_by(&mut self, delta: f32) {
        self.issued += 1;
        self.pending.push((self.issued, PendingScroll::By(delta)));
    }

    /// Records a `ScrollTo` sent to the platform.
    pub(super) fn issue_scroll_to(&mut self, offset: f32) {
        self.issued += 1;
        self.pending.push((self.issued, PendingScroll::To(offset)));
    }

    /// The platform reports its offset after applying `applied` of the
    /// issued scrolls: scrolls it has not applied yet still count, so a
    /// report that predates them does not move the window backwards.
    pub(super) fn reported(&mut self, offset: f32, applied: u32) {
        self.pending.retain(|&(n, _)| n > applied);
        let at = replay(offset, &self.pending);
        self.moved_to(at, self.pending.is_empty());
    }

    /// No scroll the core issued is waiting for the platform.
    pub(super) fn settled(&self) -> bool {
        self.pending.is_empty()
    }

    /// The list is at `at`; `settled`: with every scroll the core issued
    /// applied, so a pinned target the list is away from was left by the
    /// user.
    fn moved_to(&mut self, at: f32, settled: bool) {
        let moved = at != self.offset;
        if moved {
            let step = at - self.offset;
            self.lead = if self.inverted { -step } else { step };
            if (at - self.offset).abs() > PIN_SLACK {
                // Not a platform's rounding: the user scrolled.
                self.moved_by_scroll = true;
            }
            self.offset = at;
            self.dirty = true;
        }
        let reading_displaced =
            matches!(&self.pin, Some(Pin::Reading { at: expected, .. }) if at != *expected);
        if reading_displaced {
            // Replay already includes every unapplied correction. A real
            // displacement wins immediately, even with corrections pending.
            self.pin = None;
        }
        if let Some(Pin::Following {
            target,
            at: pinned,
            animating,
            automatic,
        }) = &mut self.pin
            && settled
        {
            if (at - *pinned).abs() <= PIN_SLACK {
                if *animating {
                    // Landed: a correction may follow.
                    *animating = false;
                    self.dirty = true;
                }
            } else if !*animating {
                // An automatic target remains the latest intent while the
                // user operates the list; explicit pins end on user scroll.
                self.pin = automatic.then_some(Pin::WaitingForIdle {
                    target: *target,
                    animated: false,
                });
            }
        }
        if (moved || reading_displaced) && self.pin.is_none() {
            // Capture from the geometry the user actually scrolled through,
            // before a source reply in this same turn can replace it. This
            // also begins reading when the user leaves end/target following.
            self.anchor_source(false, 0.0, None);
        }
    }

    /// A layout correction changes the offset's coordinate basis, keeping
    /// its previous distance from the end. Inverted lists instead integrate
    /// end changes in `anchor_end`, separately from their visible-row correction.
    pub(super) fn compensate_layout_offset(&mut self, by: f32) {
        self.offset += by;
        if !self.inverted {
            self.anchored_end += by;
        }
    }

    /// A parent-viewport list already arranged this owner correction.
    pub(super) fn anchor_by(&mut self, by: f32) {
        self.compensate_layout_offset(by);
        if let Some(Pin::Following { at, .. } | Pin::Reading { at, .. }) = &mut self.pin {
            *at += by;
        }
        self.dirty = true;
    }

    /// Keeps following `target` after a scroll command sent the list to
    /// `offset` (animated or not); `None` (a plain offset) ends the pin.
    pub(super) fn pin(
        &mut self,
        target: Option<PinTarget>,
        offset: f32,
        animated: bool,
        automatic: bool,
    ) {
        // An app scroll, including initialScrollIndex, approaches the start.
        self.moved_by_scroll = true;
        self.pin = target.map(|target| Pin::Following {
            target,
            at: offset,
            animating: animated,
            automatic,
        });
    }

    /// The content offset for `target` with the sizes known now.
    pub(super) fn target_offset(&self, target: PinTarget) -> f32 {
        match target {
            PinTarget::End => self.end_offset(),
            PinTarget::Index {
                index,
                view_position,
                view_offset,
            } => self.offset_for_index(index, view_position, view_offset),
        }
    }

    /// A new automatic request replaces the previous target without issuing a
    /// native scroll while interaction is unknown or active.
    pub(super) fn wait_for_idle(&mut self, target: PinTarget, animated: bool) {
        self.pin = Some(Pin::WaitingForIdle { target, animated });
        self.dirty = true;
    }

    pub(super) fn idle(&self) -> bool {
        self.interaction == Some(0)
    }

    /// The platform reports the list's own hover and focus-within together.
    /// Child focus style propagation cannot temporarily make this list idle.
    pub(super) fn interaction(&mut self, states: u8) {
        if !self.automatic {
            return;
        }
        let states =
            states & (crate::tailwind::state::HOVERED | crate::tailwind::state::FOCUS_WITHIN);
        if self.interaction != Some(states) {
            self.interaction = Some(states);
            self.dirty = true;
        }
    }

    /// After measurements, follows the one pending target with current sizes.
    /// Automatic requests stay pending until native interaction is known idle.
    pub(super) fn follow_pin(&mut self, anchored: f32) -> Follow {
        let Some(pin) = self.pin.clone() else {
            return Follow::Stay;
        };
        if self.viewport <= 0.0 {
            return Follow::Stay;
        }
        let (target, mut at, animating, automatic) = match pin {
            Pin::Reading { .. } => return Follow::Stay,
            Pin::WaitingForIdle { target, animated } => {
                if self.interaction != Some(0) {
                    return Follow::Stay;
                }
                let offset = self.target_offset(target);
                self.pin(Some(target), offset, animated, true);
                if !animated {
                    self.jump(offset);
                }
                return Follow::To { offset, animated };
            }
            Pin::Following {
                target,
                at,
                animating,
                automatic,
            } => {
                if automatic && !self.idle() {
                    self.wait_for_idle(target, animating);
                    return Follow::Stay;
                }
                (target, at, animating, automatic)
            }
        };
        let offset = self.target_offset(target);
        if animating {
            at += anchored;
            let follow = if (offset - at).abs() > PIN_SLACK {
                at = offset;
                Follow::To {
                    offset,
                    animated: true,
                }
            } else {
                Follow::Stay
            };
            self.pin = Some(Pin::Following {
                target,
                at,
                animating,
                automatic,
            });
            return follow;
        }
        let delta = offset - self.offset;
        if delta != 0.0 {
            self.jump(offset);
        }
        self.pin = (automatic || !self.viewport_measured()).then_some(Pin::Following {
            target,
            at: offset,
            animating,
            automatic,
        });
        if delta == 0.0 {
            Follow::Stay
        } else {
            Follow::By(delta)
        }
    }

    /// Whether a scroll command's target is still followed.
    #[cfg(test)]
    pub(super) fn pinned(&self) -> bool {
        self.pin.is_some()
    }

    pub(super) fn source_row_matches_layout(&self, index: u32, size: f32) -> bool {
        let index = index as usize;
        // An exact estimate already places the clean cell at its actual extent.
        index < self.sizes.len() && self.effective(index) == size
    }

    pub(super) fn reading_point(&self) -> Option<&SourcePoint> {
        match &self.pin {
            Some(Pin::Reading { point, .. }) => Some(point),
            _ => None,
        }
    }

    /// Keep the source glyph the reader saw at the same viewport position.
    /// Explicit navigation wins; end-follow prevents starting a new reading pin.
    pub(super) fn anchor_source(
        &mut self,
        explicit: bool,
        anchored: f32,
        position: Option<SourcePosition>,
    ) -> f32 {
        let near_end = self
            .follow_end
            .is_some_and(|threshold| self.content_len() - self.viewport - self.offset <= threshold);
        if explicit || self.parent || self.horizontal || self.inverted {
            if matches!(self.pin, Some(Pin::Reading { .. })) {
                self.pin = None;
            }
            return 0.0;
        }
        if let Some(Pin::Reading { point, line, at }) = self.pin.clone() {
            let position = position.unwrap_or_else(|| {
                self.source_geometry
                    .position(&point)
                    .map_or(SourcePosition::Closed, SourcePosition::Ready)
            });
            if position == SourcePosition::Pending {
                // Item/splice compensation already moved the speculative offset.
                // Keep the one source intent while its logical row is binding.
                self.pin = Some(Pin::Reading {
                    point,
                    line,
                    at: self.offset,
                });
                return 0.0;
            }
            if let SourcePosition::Ready(y) = position {
                let offset = self.clamped(y - line);
                // `at` includes earlier issued corrections, but not this
                // turn's item/splice anchoring. A native report may have
                // overwritten its speculative offset; count that anchoring
                // exactly once in the final relative command.
                let delta = offset - at - anchored;
                self.offset = offset;
                self.pin = Some(Pin::Reading {
                    point,
                    line,
                    at: offset,
                });
                return delta;
            }
            self.pin = None;
        }
        if !near_end
            && self.pin.is_none()
            && self
                .pending
                .iter()
                .all(|(_, scroll)| matches!(scroll, PendingScroll::By(_)))
            && let Some((point, y)) = self
                .source_geometry
                .first_visible(self.offset, self.offset + self.viewport)
        {
            self.pin = Some(Pin::Reading {
                point,
                line: y - self.offset,
                at: self.offset,
            });
        }
        0.0
    }

    /// Whether every item overlapping the viewport has its measured size.
    fn viewport_measured(&self) -> bool {
        let start = self.natural_offset();
        self.items_in(start, start + self.viewport)
            .is_none_or(|(first, last)| {
                self.sizes[first as usize..=last as usize]
                    .iter()
                    .all(|s| !s.is_nan())
            })
    }

    // --- Geometry ----------------------------------------------------------

    fn effective(&self, i: usize) -> f32 {
        let s = self.sizes[i];
        if s.is_nan() { self.estimated } else { s }
    }

    fn row_count(&self) -> u32 {
        self.count.div_ceil(self.columns)
    }

    fn row_of(&self, i: u32) -> u32 {
        i / self.columns
    }

    /// Size of row `r`: its largest item.
    fn row_size(&self, r: u32) -> f32 {
        let start = (r * self.columns) as usize;
        let end = (start + self.columns as usize).min(self.sizes.len());
        (start..end).map(|i| self.effective(i)).fold(0.0, f32::max)
    }

    /// The gap between rows along the main axis.
    fn main_gap(&self) -> f32 {
        if self.horizontal {
            self.content.column_gap.0
        } else {
            self.content.row_gap.0
        }
    }

    /// The gap between columns.
    pub(super) fn cross_gap(&self) -> f32 {
        if self.horizontal {
            self.content.row_gap.0
        } else {
            self.content.column_gap.0
        }
    }

    /// Padding at the start / end of the main axis and of the cross axis.
    fn main_padding(&self) -> (f32, f32) {
        let p = &self.content.padding;
        if self.horizontal {
            (p.left.0, p.right.0)
        } else {
            (p.top.0, p.bottom.0)
        }
    }

    pub(super) fn cross_padding(&self) -> (f32, f32) {
        let p = &self.content.padding;
        if self.horizontal {
            (p.top.0, p.bottom.0)
        } else {
            (p.left.0, p.right.0)
        }
    }

    fn rows_changed(&mut self) {
        self.dirty = true;
    }

    fn rebuild_offsets(&mut self) {
        self.source_dirty |= !self.source_geometry.is_empty();
        let gap = self.main_gap() as f64;
        let rows = (0..self.row_count()).map(|r| self.row_size(r) as f64 + gap);
        self.rows = Fenwick::from_sizes(rows.collect::<Vec<_>>().into_iter());
        self.dirty = true;
    }

    /// Length of the item rows (no trailing gap).
    fn items_len(&self) -> f32 {
        if self.count == 0 {
            0.0
        } else {
            self.rows.total() as f32 - self.main_gap()
        }
    }

    /// Start of each block of content, in natural coordinates.
    pub(super) fn blocks(&self) -> Blocks {
        let gap = self.main_gap();
        let (start, end) = self.main_padding();
        let [header, footer, empty] = &self.extras;
        let mut at = start;
        let mut any = false;
        let mut place = |present: bool, size: f32| {
            if !present {
                return at;
            }
            if any {
                at += gap;
            }
            any = true;
            let here = at;
            at += size;
            here
        };
        let header_at = place(header.present(), header.size);
        let body_at = if self.count > 0 {
            place(true, self.items_len())
        } else {
            place(empty.present(), empty.size)
        };
        let footer_at = place(footer.present(), footer.size);
        Blocks {
            header: header_at,
            body: body_at,
            footer: footer_at,
            total: at + end,
        }
    }

    /// Total content length along the main axis (what the platform
    /// scrolls).
    pub(super) fn content_len(&self) -> f32 {
        let total = self.blocks().total;
        if self.inverted {
            total.max(self.viewport)
        } else {
            total
        }
    }

    /// Content coordinate of a span at natural position `at` of length
    /// `size`.
    pub(super) fn to_content(&self, at: f32, size: f32) -> f32 {
        if self.inverted {
            self.content_len() - at - size
        } else {
            at
        }
    }

    /// The viewport's start in natural coordinates.
    fn natural_offset(&self) -> f32 {
        if self.inverted {
            self.content_len() - self.offset - self.viewport
        } else {
            self.offset
        }
    }

    /// Natural position of item `i` (its row's start).
    pub(super) fn item_at(&self, i: u32) -> f32 {
        self.blocks().body + self.rows.prefix(self.row_of(i) as usize) as f32
    }

    /// Size and position of each cell across the main axis: `(offset,
    /// size)` of column `col`.
    pub(super) fn column(&self, cross: f32, col: u32) -> (f32, f32) {
        let (start, end) = self.cross_padding();
        let gap = self.cross_gap();
        let n = self.columns as f32;
        let width = ((cross - start - end - gap * (n - 1.0)) / n).max(0.0);
        (start + col as f32 * (width + gap), width)
    }

    /// The cross-axis span of extras: the content width inside padding.
    pub(super) fn full_width(&self, cross: f32) -> (f32, f32) {
        let (start, end) = self.cross_padding();
        (start, (cross - start - end).max(0.0))
    }

    /// Main-axis size of item `i`'s row.
    pub(super) fn row_extent(&self, i: u32) -> f32 {
        self.row_size(self.row_of(i))
    }

    pub(super) fn column_of(&self, i: u32) -> u32 {
        i % self.columns
    }

    // --- Updates -----------------------------------------------------------

    pub(super) fn set_count(&mut self, count: u32) -> Vec<u32> {
        if count == self.count {
            return Vec::new();
        }
        let deleted: Vec<_> = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(slot, state)| {
                state
                    .index
                    .filter(|&index| index >= count)
                    .map(|_| slot as u32)
            })
            .collect();
        let mut revoked = Vec::new();
        for slot in deleted {
            self.revoke_source(slot, &mut revoked);
        }
        self.count = count;
        for slot in &mut self.slots {
            if slot.index.is_some() && matches!(slot.native, NativeCell::Retiring(_)) {
                slot.native = NativeCell::Mounted;
                self.native_ops
                    .push(NativeCellOp::Attach { cell: slot.cell });
            }
        }
        self.source_dirty |= !self.source_geometry.is_empty();
        self.sizes.resize(count as usize, f32::NAN);
        self.rebuild_offsets();
        if self.load_more_at.is_some_and(|c| c != count) {
            self.load_more_at = None;
        }
        revoked
    }

    /// The source deleted this assignment. Its old native owner cannot be
    /// rebound until removal has crossed the existing native acknowledgement.
    fn revoke_source(&mut self, slot: u32, revoked: &mut Vec<u32>) {
        let state = &mut self.slots[slot as usize];
        if let Some(index) = state.index.take() {
            self.by_index.remove(&index);
        }
        state.requested = None;
        state.rendered = None;
        if self.focused == Some(slot) {
            self.focused = None;
        }
        if state.cell == u32::MAX {
            state.native = NativeCell::Detached;
            self.free.push(slot);
        } else {
            let request = self.retirement_requests.get() + 1;
            self.retirement_requests.set(request);
            state.native = NativeCell::Retiring(request);
            revoked.push(state.cell);
        }
        self.dirty = true;
    }

    pub(super) fn set_estimated(&mut self, estimated: f32) {
        if estimated > 0.0 && estimated != self.estimated {
            self.estimated = estimated;
            self.rebuild_offsets();
        }
    }

    pub(super) fn set_columns(&mut self, columns: u32) {
        let columns = columns.max(1);
        if columns != self.columns {
            self.columns = columns;
            // Cells change width: their sizes are measured again.
            self.sizes.fill(f32::NAN);
            self.cells_cross = f32::NAN;
            self.rebuild_offsets();
        }
    }

    /// `contentStyle`: it wins over `contentClass` when set.
    pub(super) fn set_content(&mut self, content: ListContentStyle) {
        self.content_style = content;
        self.apply_content();
    }

    /// What `contentClass` sets.
    pub(super) fn set_class_content(&mut self, content: ListContentStyle) {
        self.content_class = content;
        self.apply_content();
    }

    fn apply_content(&mut self) {
        let content = if self.content_style != ListContentStyle::default() {
            self.content_style
        } else {
            self.content_class
        };
        if content != self.content {
            let cross_changed = self.cross_padding() != {
                let p = &content.padding;
                if self.horizontal {
                    (p.top.0, p.bottom.0)
                } else {
                    (p.left.0, p.right.0)
                }
            } || self.cross_gap()
                != if self.horizontal {
                    content.row_gap.0
                } else {
                    content.column_gap.0
                };
            self.content = content;
            if cross_changed {
                self.cells_cross = f32::NAN;
            }
            self.rebuild_offsets();
        }
    }

    pub(super) fn set_horizontal(&mut self, horizontal: bool) {
        if horizontal != self.horizontal {
            self.horizontal = horizontal;
            self.sizes.fill(f32::NAN);
            self.rebuild_offsets();
        }
    }

    pub(super) fn set_inverted(&mut self, inverted: bool) {
        if self.parent {
            self.ignored |= if inverted { ignored::INVERTED } else { 0 };
            return;
        }
        if inverted != self.inverted {
            self.inverted = inverted;
            self.anchored_end = f32::NAN;
            self.dirty = true;
        }
    }

    pub(super) fn set_follow_end(&mut self, threshold: Option<f32>) {
        if self.parent {
            self.ignored |= if threshold.is_some() {
                ignored::FOLLOW_END
            } else {
                0
            };
            return;
        }
        if threshold != self.follow_end {
            self.follow_end = threshold;
            self.anchored_end = f32::NAN;
            self.dirty = true;
        }
    }

    pub(super) fn set_sticky(&mut self, mut sticky: Vec<u32>) {
        sticky.sort_unstable();
        sticky.dedup();
        if sticky != self.sticky {
            self.sticky = sticky;
            self.dirty = true;
        }
    }

    /// `stickyHeaderOffset` as an animated value.
    pub(super) fn set_sticky_node(&mut self, node: Option<crate::animation::NodeId>) {
        if node != self.sticky_node {
            self.sticky_node = node;
            self.dirty = true;
        }
    }

    /// `stickyHeaderOffset`.
    pub(super) fn set_sticky_offset(&mut self, offset: f32) {
        let offset = if offset.is_finite() { offset } else { 0.0 };
        if offset != self.sticky_offset {
            self.sticky_offset = offset;
            self.dirty = true;
        }
    }

    /// Records a measured size. Returns the change if the item lies
    /// entirely before the viewport (the caller scrolls by it so the
    /// visible content stays put).
    pub(super) fn measured(&mut self, i: u32, size: f32) -> f32 {
        let idx = i as usize;
        if idx >= self.sizes.len() || self.sizes[idx] == size {
            return 0.0;
        }
        let row = self.row_of(i);
        let before = self.row_size(row);
        let row_start = self.item_at(i);
        let natural = self.natural_offset();
        let above_viewport = row_start < natural && row_start + before <= natural;
        let keep = above_viewport && self.keeps_visible_rows();
        self.sizes[idx] = size;
        let delta = self.row_size(row) - before;
        if delta != 0.0 {
            self.rows.add(row as usize, delta as f64);
        }
        self.dirty = true;
        self.before_viewport_changed(keep, delta, natural)
    }

    /// The scroll that keeps the visible rows in place after something
    /// before the viewport changed by `delta` (at natural offset `natural`
    /// before the change), when `keep`. An inverted list cancels what
    /// `anchor_end` will scroll to keep its distance from the end, without
    /// going past its start.
    fn before_viewport_changed(&self, keep: bool, delta: f32, natural: f32) -> f32 {
        match (keep, self.inverted) {
            (false, _) => 0.0,
            (true, false) => delta,
            (true, true) => -delta.max(-natural),
        }
    }

    /// Records the size of an extra cell; returns the anchoring change as
    /// [`ListState::measured`] does.
    pub(super) fn measured_extra(&mut self, kind: ExtraKind, size: f32) -> f32 {
        let blocks = self.blocks();
        let natural = self.natural_offset();
        let keeps = self.keeps_visible_rows();
        let extra = &mut self.extras[kind as usize];
        if extra.size == size {
            return 0.0;
        }
        let delta = size - extra.size;
        extra.size = size;
        self.rows_changed();
        let at = match kind {
            ExtraKind::Header => blocks.header,
            ExtraKind::Footer => blocks.footer,
            ExtraKind::Empty => blocks.body,
        };
        // An extra entirely before the viewport's start (not one that was
        // empty at the top, with the list at the top); inverted lists at
        // their start keep their distance from the end (`anchor_end`).
        let old_end = at + size - delta;
        let keep = keeps && at < natural && old_end <= natural;
        self.before_viewport_changed(keep, delta, natural)
    }

    /// Predicts the platform's upper clamp before its scroll report arrives.
    /// Later relative corrections must start at the same clamped reported offset;
    /// explicit pins supply their own correction before the viewport frame.
    pub(super) fn predict_clamp(&mut self, maximum: f32) {
        if !self.inverted
            && self.follow_end.is_some()
            && matches!(self.pin, None | Some(Pin::Reading { .. }))
        {
            self.offset = self.offset.min(maximum);
        }
    }

    /// Inverted lists keep their distance from the end of the content:
    /// returns how far to scroll after content or viewport changes (and
    /// starts at the end). Other lists with `follow_end` stay at the end
    /// when the end moves away while they are within the threshold of it
    /// (a growing last item, a shrinking viewport); scrolled further up,
    /// they keep what is visible (content grows below it).
    pub(super) fn anchor_end(&mut self) -> f32 {
        if self.viewport <= 0.0 {
            return 0.0;
        }
        let end = (self.content_len() - self.viewport).max(0.0);
        if !self.inverted {
            if matches!(self.pin, Some(Pin::Reading { .. })) {
                // A temporary projection shrink is not an end-follow intent.
                self.anchored_end = end;
                return 0.0;
            }
            let Some(threshold) = self.follow_end else {
                return 0.0;
            };
            let was = std::mem::replace(&mut self.anchored_end, end);
            if was.is_nan() || end <= was || was - self.offset > threshold {
                return 0.0;
            }
            let delta = end - self.offset;
            self.offset = end;
            return delta;
        }
        let delta = if self.anchored_end.is_nan() {
            end - self.offset
        } else {
            end - self.anchored_end
        };
        self.anchored_end = end;
        self.offset += delta;
        delta
    }

    /// The platform is about to scroll to `offset` (a command): the window
    /// follows it right away, and inverted lists anchor to it.
    pub(super) fn jump(&mut self, offset: f32) {
        self.offset = offset;
        if self.inverted {
            self.anchored_end = (self.content_len() - self.viewport).max(0.0);
        }
        self.dirty = true;
    }

    /// The content offset that shows item `index` at `view_position` (0:
    /// start of the viewport, 1: end) shifted by `view_offset`, clamped to
    /// the content.
    pub(super) fn offset_for_index(&self, index: u32, view_position: f32, view_offset: f32) -> f32 {
        let index = index.min(self.count.saturating_sub(1));
        let size = self.row_size(self.row_of(index));
        let at = self.to_content(self.item_at(index), size);
        let free = self.viewport - size;
        let offset = if self.inverted {
            // Mirrored like the inverted list itself.
            at - (1.0 - view_position) * free + view_offset
        } else {
            at - view_position * free - view_offset
        };
        let (min, max) = self.offset_limits();
        offset.clamp(min, max)
    }

    pub(super) fn end_offset(&self) -> f32 {
        if self.inverted {
            0.0
        } else if self.parent {
            // The list's end at the end of the viewport.
            let (min, max) = self.limits;
            (self.content_len() - self.viewport).clamp(min, max)
        } else {
            (self.content_len() - self.viewport).max(0.0)
        }
    }

    // --- Cells -------------------------------------------------------------

    pub(super) fn add_slot_cell(&mut self, slot: CellSlot, cell: u32) {
        self.source_dirty |= !self.source_geometry.is_empty();
        let s = match slot {
            CellSlot::Item(s) => s as usize,
            CellSlot::Header => return self.set_extra(ExtraKind::Header, cell),
            CellSlot::Footer => return self.set_extra(ExtraKind::Footer, cell),
            CellSlot::Empty => return self.set_extra(ExtraKind::Empty, cell),
        };
        if s >= self.slots.len() {
            self.slots.resize(
                s + 1,
                Slot {
                    cell: u32::MAX,
                    index: None,
                    rendered: None,
                    requested: None,
                    native: NativeCell::Detached,
                },
            );
        }
        self.slots[s].cell = cell;
        self.dirty = true;
    }

    fn set_extra(&mut self, kind: ExtraKind, cell: u32) {
        self.extras[kind as usize] = Extra { cell, size: 0.0 };
        self.dirty = true;
    }

    pub(super) fn remove_cell(&mut self, cell: u32) {
        self.source_dirty |= !self.source_geometry.is_empty();
        for slot in &mut self.slots {
            if slot.cell == cell {
                slot.cell = u32::MAX;
                slot.rendered = None;
                slot.requested = None;
                slot.native = NativeCell::Detached;
                self.dirty = true;
            }
        }
        if self
            .focused
            .is_some_and(|slot| self.slots[slot as usize].cell == u32::MAX)
        {
            self.focused = None;
        }
        for extra in &mut self.extras {
            if extra.cell == cell {
                *extra = Extra::NONE;
                self.dirty = true;
            }
        }
    }

    pub(super) fn rendered(&mut self, cell: u32, index: u32) {
        if let Some(slot) = self.slots.iter_mut().find(|s| s.cell == cell) {
            // A previously unready cell may supply the first source geometry.
            self.source_dirty = true;
            slot.rendered = Some(index);
            self.dirty = true;
        }
    }

    pub(super) fn focus_cell(&mut self, cell: Option<u32>) {
        let focused = cell
            .and_then(|cell| {
                self.slots.iter().position(|slot| {
                    slot.cell == cell && slot.index.is_some_and(|index| index < self.count)
                })
            })
            .map(|slot| slot as u32);
        if self.focused != focused {
            self.focused = focused;
            self.dirty = true;
        }
        if let Some(slot) = focused {
            self.cancel_retirement(self.slots[slot as usize].cell);
        }
    }

    pub(super) fn cancel_retirement(&mut self, cell: u32) {
        if let Some(slot) = self.slots.iter_mut().find(|slot| slot.cell == cell)
            && slot.index.is_some()
            && matches!(slot.native, NativeCell::Retiring(_))
        {
            slot.native = NativeCell::Mounted;
            self.native_ops.push(NativeCellOp::Attach { cell });
            self.dirty = true;
        }
    }

    pub(super) fn projected(&mut self, cell: u32) {
        if let Some(slot) = self.slots.iter_mut().find(|slot| slot.cell == cell)
            && slot.index.is_some()
        {
            // Every native Insert supersedes an earlier detach request,
            // including an Insert that only changed the cell's z-order.
            self.dirty |= matches!(slot.native, NativeCell::Retiring(_));
            slot.native = NativeCell::Mounted;
        }
    }

    pub(super) fn current_retirement(&self, cell: u32, request: u64) -> bool {
        self.slots
            .iter()
            .any(|slot| slot.cell == cell && slot.native == NativeCell::Retiring(request))
    }

    pub(super) fn current_attachment(&self, cell: u32) -> bool {
        self.slots.iter().any(|slot| {
            slot.cell == cell && slot.native == NativeCell::Mounted && slot.ready().is_some()
        })
    }

    pub(super) fn native_visible(&self, cell: u32) -> Option<bool> {
        self.slots
            .iter()
            .find(|slot| slot.cell == cell)
            .map(|slot| slot.index.is_some() && slot.native != NativeCell::Detached)
    }

    pub(super) fn source_live(&self, cell: u32) -> Option<bool> {
        self.slots
            .iter()
            .find(|slot| slot.cell == cell)
            .map(|slot| slot.index.is_some())
    }

    pub(super) fn retirement_request(&self, cell: u32) -> Option<u64> {
        self.slots.iter().find_map(|slot| match slot.native {
            NativeCell::Retiring(request) if slot.cell == cell => Some(request),
            _ => None,
        })
    }

    /// Only a matching native detach releases the slot for reuse. Refused,
    /// cancelled and source-invalidated requests cannot retire a new owner.
    pub(super) fn retire_cell(&mut self, cell: u32, request: u64, retired: bool) -> bool {
        let Some(at) = self
            .slots
            .iter()
            .position(|slot| slot.cell == cell && slot.native == NativeCell::Retiring(request))
        else {
            return false;
        };
        if !retired && self.slots[at].index.is_none() {
            return false;
        }
        self.slots[at].native = if retired {
            NativeCell::Detached
        } else {
            NativeCell::Mounted
        };
        if retired {
            if self.slots[at].index.is_some() {
                self.unbind(at as u32);
            } else {
                self.free.push(at as u32);
            }
        }
        self.dirty = true;
        retired
    }

    pub(super) fn current_bind(&self, slot: u32, index: u32) -> bool {
        self.slots.get(slot as usize).is_some_and(|slot| {
            // A surviving source item may move while its cell awaits native
            // retirement. Its existing owner still needs the updated index;
            // quarantine prevents this from assigning a different item.
            slot.index == Some(index) && slot.requested == Some(index)
        })
    }

    // --- Window ------------------------------------------------------------

    /// Item range `first..=last` of rows overlapping the natural span
    /// `[start, end]`, or `None`.
    fn items_in(&self, start: f32, end: f32) -> Option<(u32, u32)> {
        if self.count == 0 {
            return None;
        }
        let body = self.blocks().body;
        if end < body || start > body + self.items_len() {
            return None;
        }
        let first_row = self.rows.find((start - body).max(0.0) as f64) as u32;
        let last_row =
            (self.rows.find((end - body).max(0.0) as f64) as u32).min(self.row_count() - 1);
        let first = first_row * self.columns;
        let last = ((last_row + 1) * self.columns - 1).min(self.count - 1);
        Some((first, last))
    }

    /// The span of content (main axis, content coordinates) whose items
    /// are rendered: the viewport and the overscan around it.
    pub(super) fn render_window(&self) -> (f32, f32) {
        let overscan = self.viewport * OVERSCAN;
        (
            self.offset - overscan,
            self.offset + self.viewport + overscan,
        )
    }

    /// The sticky item currently pinned to the viewport's start (or its
    /// sticky offset from it): the last one that starts before that.
    pub(super) fn active_sticky(&self) -> Option<u32> {
        if !self.sticky_enabled() {
            return None;
        }
        let at = self.natural_offset() + self.sticky_offset;
        let mut active = None;
        for &s in &self.sticky {
            if s >= self.count || self.item_at(s) > at {
                break;
            }
            active = Some(s);
        }
        active
    }

    /// Sticky items need one column and a list that is not inverted (as in
    /// React Native).
    pub(super) fn sticky_enabled(&self) -> bool {
        !self.sticky.is_empty() && self.columns == 1 && !self.inverted
    }

    /// The travel range of sticky item `index`: from where it reaches the
    /// sticky offset from the viewport's start to where the next sticky item
    /// pushes it out.
    ///
    /// In its parent's viewport, the range is in the offsets of the view
    /// around the list, and the last sticky item stops where its bottom
    /// meets the end of the list's content.
    pub(super) fn sticky_range(&self, index: u32, cell: u32, size: f32) -> StickyRange {
        let start = self.item_at(index) - self.sticky_offset;
        let next = self.sticky.iter().find(|&&s| s > index && s < self.count);
        let end = match next {
            Some(&n) => (self.item_at(n) - size - self.sticky_offset).max(start),
            None if self.parent => {
                let end = self.blocks().total - self.main_padding().1;
                (end - size - self.sticky_offset).max(start)
            }
            None => f32::INFINITY,
        };
        if self.parent {
            let at = self.outer_start;
            return StickyRange {
                cell,
                start: at + start,
                end: at + end,
                offset: self.sticky_node,
            };
        }
        StickyRange {
            cell,
            start,
            end,
            offset: self.sticky_node,
        }
    }

    /// Recomputes the render window. `(slot, index)` bindings due now are
    /// pushed to `binds`: cells whose item moved, and new ones in the
    /// viewport or just ahead of it (all of them unless `paced`). Returns
    /// the load-more events to raise.
    pub(super) fn update_window(
        &mut self,
        binds: &mut Vec<(u32, u32)>,
        source_row: Option<u32>,
    ) -> Edges {
        self.dirty = false;
        // Several splices can share one published source. Intermediate
        // indices no longer describe that source or the slot's current item.
        self.moved
            .retain(|&(slot, index)| self.slots[slot as usize].index == Some(index));
        // Cells whose item moved learn their final index before anything
        // else binds, including when their viewport just became empty.
        binds.append(&mut self.moved);
        let focused = self
            .focused
            .and_then(|slot| self.slots[slot as usize].index)
            .filter(|&index| index < self.count);
        if self.count == 0 || self.viewport <= 0.0 {
            for slot in 0..self.slots.len() {
                // A temporarily collapsed viewport does not revoke native
                // input focus. Its one live owner still needs to survive.
                if focused.is_none() || self.slots[slot].index != focused {
                    self.release_slot(slot as u32);
                }
            }
            return Edges::default();
        }
        let at = self.natural_offset();
        let overscan = self.viewport * OVERSCAN;
        let range = self.items_in(at - overscan, at + self.viewport + overscan);
        let sticky = self.active_sticky();
        // And the one before it: scrolled back, it shows at once, pushed by
        // the pinned one, before a round of binding could render it.
        let before = sticky.and_then(|s| self.sticky.iter().rev().find(|&&p| p < s).copied());
        let wanted = |i: u32| {
            range.is_some_and(|(f, l)| (f..=l).contains(&i))
                || sticky == Some(i)
                || before == Some(i)
                || focused == Some(i)
                || source_row == Some(i)
        };

        for slot in 0..self.slots.len() as u32 {
            if let Some(i) = self.slots[slot as usize].index
                && !wanted(i)
            {
                self.release_slot(slot);
            } else if self.slots[slot as usize].index.is_some()
                && matches!(self.slots[slot as usize].native, NativeCell::Retiring(_))
            {
                let cell = self.slots[slot as usize].cell;
                self.slots[slot as usize].native = NativeCell::Mounted;
                self.native_ops.push(NativeCellOp::Attach { cell });
            }
        }
        let bind = |this: &mut Self, i: u32| {
            if this.by_index.contains_key(&i) {
                return;
            }
            let slot = match this.free.pop() {
                Some(slot) => slot,
                None => {
                    this.slots.push(Slot {
                        cell: u32::MAX,
                        index: None,
                        rendered: None,
                        requested: None,
                        native: NativeCell::Detached,
                    });
                    this.slots.len() as u32 - 1
                }
            };
            this.slots[slot as usize].index = Some(i);
            this.by_index.insert(i, slot);
        };
        if let Some((first, last)) = range {
            for i in first..=last {
                bind(self, i);
            }
        }
        for s in [before, sticky, focused, source_row].into_iter().flatten() {
            bind(self, s);
        }
        let (start, end) = self.urgent_span(at);
        let new = binds.len();
        for slot in 0..self.slots.len() {
            let s = self.slots[slot];
            let Some(i) = s.index else { continue };
            if s.requested == Some(i) {
                continue;
            }
            if matches!(s.native, NativeCell::Retiring(_)) {
                continue;
            }
            if !self.paced
                || sticky == Some(i)
                || before == Some(i)
                || focused == Some(i)
                || source_row == Some(i)
                || self.item_overlaps(i, start, end)
            {
                self.slots[slot].requested = Some(i);
                binds.push((slot as u32, i));
            }
        }
        binds[new..].sort_unstable_by_key(|b| b.1);

        let total = self.blocks().total;
        let near_end = at + self.viewport >= total - self.viewport * self.end_threshold;
        let mut edges = Edges::default();
        if near_end && self.load_more_at != Some(self.count) {
            self.load_more_at = Some(self.count);
            edges.end = true;
        }
        // Once per approach: again only after the viewport left the start,
        // or when the items changed while it stayed there (a page that did
        // not fill the threshold). Not where the list opens, unless the
        // user or a scroll command moved it.
        let near_start = at <= self.viewport * self.start_threshold;
        if !near_start {
            self.load_more_at_start = None;
        } else if self.moved_by_scroll && self.load_more_at_start != Some(self.count) {
            self.load_more_at_start = Some(self.count);
            edges.start = true;
        }
        edges
    }

    /// The span (natural coordinates) whose cells bind with the window:
    /// the viewport, and ahead of it in the scroll direction twice the last
    /// step (what the next frames of a fling show). A step longer than the
    /// viewport is a jump: only the viewport.
    fn urgent_span(&self, at: f32) -> (f32, f32) {
        let step = self.lead.abs();
        let ahead = if step <= self.viewport {
            (2.0 * step).min(self.viewport * OVERSCAN)
        } else {
            0.0
        };
        if self.lead > 0.0 {
            (at, at + self.viewport + ahead)
        } else {
            (at - ahead, at + self.viewport)
        }
    }

    /// Whether item `i`'s row overlaps `start..end` (natural coordinates).
    fn item_overlaps(&self, i: u32, start: f32, end: f32) -> bool {
        let top = self.item_at(i);
        top < end && top + self.row_size(self.row_of(i)) > start
    }

    /// Whether cells wait for [`Self::take_paced`].
    pub(super) fn has_paced(&self) -> bool {
        self.slots.iter().any(|s| {
            s.index.is_some()
                && s.index != s.requested
                && !matches!(s.native, NativeCell::Retiring(_))
        })
    }

    /// Up to `max` of the cells waiting to bind, nearest the viewport first
    /// on the side the list scrolls towards, then the other side; pushed to
    /// `binds`. Returns how many. The engine takes one at a time (it checks
    /// its budget after each), so this picks the nearest by a scan of the
    /// slots instead of sorting them.
    pub(super) fn take_paced(&mut self, max: usize, binds: &mut Vec<(u32, u32)>) -> usize {
        let mut taken = 0;
        while taken < max {
            let Some((slot, i)) = self.nearest_waiting() else {
                break;
            };
            self.slots[slot as usize].requested = Some(i);
            binds.push((slot, i));
            taken += 1;
        }
        taken
    }

    /// The waiting cell [`Self::take_paced`] binds next: `(slot, index)`.
    fn nearest_waiting(&self) -> Option<(u32, u32)> {
        let at = self.natural_offset();
        let (top, bottom) = (at, at + self.viewport);
        let forward = self.lead >= 0.0;
        let mut best: Option<((bool, f32), u32, u32)> = None;
        for (slot, s) in self.slots.iter().enumerate() {
            let Some(i) = s.index else { continue };
            if s.requested == Some(i) || matches!(s.native, NativeCell::Retiring(_)) {
                continue;
            }
            let start = self.item_at(i);
            let (distance, below) = if start >= bottom {
                (start - bottom, true)
            } else {
                let end = start + self.row_size(self.row_of(i));
                ((top - end).max(0.0), false)
            };
            // The side behind waits for the side ahead.
            let key = (below != forward, distance);
            if best.is_none_or(|(b, ..)| key.0.cmp(&b.0).then(key.1.total_cmp(&b.1)).is_lt()) {
                best = Some((key, slot as u32, i));
            }
        }
        best.map(|(_, slot, i)| (slot, i))
    }

    fn unbind(&mut self, slot: u32) {
        if let Some(i) = self.slots[slot as usize].index.take() {
            self.by_index.remove(&i);
            self.free.push(slot);
        }
    }

    fn release_slot(&mut self, slot: u32) {
        let at = slot as usize;
        if self.slots[at]
            .index
            .is_some_and(|index| index >= self.count)
        {
            self.slots[at].native = NativeCell::Detached;
        }
        match self.slots[at].native {
            NativeCell::Detached => self.unbind(slot),
            NativeCell::Mounted => {
                let request = self.retirement_requests.get() + 1;
                self.retirement_requests.set(request);
                self.slots[at].native = NativeCell::Retiring(request);
                self.native_ops.push(NativeCellOp::Retire {
                    cell: self.slots[at].cell,
                    request,
                });
            }
            NativeCell::Retiring(_) => {}
        }
    }

    /// The viewable items under the list's viewability rules (React
    /// Native's `ViewabilityHelper`): `first..=last`, or `None`.
    pub(super) fn viewable_items(&self) -> Option<(u32, u32)> {
        if self.viewport <= 0.0 {
            return None;
        }
        let top = self.natural_offset();
        let bottom = top + self.viewport;
        let (first, last) = self.items_in(top, bottom)?;
        let viewable = |row: u32| {
            let start = self.item_at(row * self.columns);
            let size = self.row_size(row);
            let end = start + size;
            if start >= top && end <= bottom {
                return true;
            }
            let pixels = (end.min(bottom) - start.max(top)).max(0.0);
            let (percent, threshold) = match (
                self.viewability.view_area_percent,
                self.viewability.item_visible_percent,
            ) {
                (Some(t), _) => (100.0 * pixels / self.viewport, t),
                (None, Some(t)) => (100.0 * pixels / size.max(f32::EPSILON), t),
                (None, None) => return pixels > 0.0,
            };
            if threshold > 0.0 {
                percent >= threshold
            } else {
                pixels > 0.0
            }
        };
        let (mut first_row, mut last_row) = (self.row_of(first), self.row_of(last));
        while first_row <= last_row && !viewable(first_row) {
            first_row += 1;
        }
        while last_row >= first_row && !viewable(last_row) {
            if last_row == 0 {
                return None;
            }
            last_row -= 1;
        }
        (first_row <= last_row).then(|| {
            (
                first_row * self.columns,
                ((last_row + 1) * self.columns - 1).min(self.count - 1),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{geometry::px, props::EdgeInsets};

    fn list(count: u32, estimated: f32, viewport: f32) -> ListState {
        let mut l = ListState::new(Rc::default());
        l.set_estimated(estimated);
        l.set_count(count);
        l.viewport = viewport;
        l
    }

    #[test]
    fn window_covers_viewport_plus_overscan() {
        let mut l = list(1000, 50.0, 400.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        // [0, 800] at 50 per item -> items 0..=16.
        assert_eq!(binds.len(), 17);
        assert_eq!(binds[0], (0, 0));

        // Scroll down a screen: items scrolled far above are recycled.
        l.offset = 2000.0;
        binds.clear();
        l.update_window(&mut binds, None);
        let indices: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(indices.first(), Some(&32));
        assert_eq!(indices.last(), Some(&56));
        // Slots were reused, not grown without bound.
        assert!(l.slots.len() <= 25 + 17, "{}", l.slots.len());
    }

    #[test]
    fn native_owner_retires_only_after_confirmation_and_focus_cancels_the_request() {
        let mut l = list(1000, 50.0, 100.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        l.add_slot_cell(CellSlot::Item(0), 42);
        l.rendered(42, 0);
        l.projected(42);
        l.offset = 5000.0;
        binds.clear();
        l.update_window(&mut binds, None);
        let first = match l.native_ops[0] {
            NativeCellOp::Retire { cell: 42, request } => request,
            other => panic!("expected native retirement, got {other:?}"),
        };
        assert_eq!(l.slots[0].index, Some(0));
        assert_eq!(
            binds.iter().map(|&(_, index)| index).collect::<Vec<_>>(),
            [98, 99, 100, 101, 102, 103, 104]
        );

        // Native can still Tab to this original owner before consuming the
        // retirement. It is one sparse retained row, not the intervening span.
        l.focus_cell(Some(42));
        assert!(!l.retire_cell(42, first, true));
        l.update_window(&mut Vec::new(), None);
        assert_eq!(l.slots[0].ready(), Some(0));
        let mut retained: Vec<_> = l.slots.iter().filter_map(|slot| slot.index).collect();
        retained.sort_unstable();
        assert_eq!(retained, [0, 98, 99, 100, 101, 102, 103, 104]);

        l.viewport = 0.0;
        l.native_ops.clear();
        l.update_window(&mut Vec::new(), None);
        assert_eq!(l.slots[0].ready(), Some(0));
        assert!(l.native_ops.is_empty());
        l.viewport = 100.0;

        l.focus_cell(None);
        l.native_ops.clear();
        l.update_window(&mut Vec::new(), None);
        let second = match l.native_ops[0] {
            NativeCellOp::Retire { cell: 42, request } => request,
            other => panic!("expected another retirement, got {other:?}"),
        };
        assert_ne!(second, first);
        assert!(!l.retire_cell(42, first, true));
        assert_eq!(l.slots[0].ready(), Some(0));
        // A projection reorder is another native attach. Its old detach
        // reply cannot release the now-attached owner.
        l.projected(42);
        assert!(!l.retire_cell(42, second, true));
        l.native_ops.clear();
        l.update_window(&mut Vec::new(), None);
        let third = match l.native_ops[0] {
            NativeCellOp::Retire { cell: 42, request } => request,
            other => panic!("expected retirement after reordering, got {other:?}"),
        };
        assert_ne!(third, second);
        assert!(l.retire_cell(42, third, true));
        assert_eq!(l.slots[0].index, None);
    }

    #[test]
    fn source_splices_move_retained_focus_but_revoke_deleted_owners_and_old_replies() {
        let mut l = list(1000, 50.0, 100.0);
        l.update_window(&mut Vec::new(), None);
        l.add_slot_cell(CellSlot::Item(0), 42);
        l.rendered(42, 0);
        l.projected(42);
        l.offset = 5000.0;
        l.update_window(&mut Vec::new(), None);
        let request = match l.native_ops[0] {
            NativeCellOp::Retire { cell: 42, request } => request,
            other => panic!("expected native retirement, got {other:?}"),
        };
        l.splice(0, 0, 1);
        assert!(!l.retire_cell(42, request, true));
        let mut moved = Vec::new();
        l.update_window(&mut moved, None);
        assert!(moved.contains(&(0, 1)));
        assert!(matches!(l.slots[0].native, NativeCell::Retiring(_)));
        let moved_request = l.retirement_request(42).unwrap();
        assert!(l.current_bind(0, 1));
        assert!(!l.current_bind(0, 0));
        l.focus_cell(Some(42));
        assert_eq!(l.slots[0].ready(), Some(1));
        assert_eq!(l.focused, Some(0));

        assert_eq!(l.splice(1, 1, 1), [42]);
        let source_request = l.retirement_request(42).unwrap();
        assert_ne!(source_request, moved_request);
        assert_eq!(l.focused, None);
        assert_eq!(l.slots[0].index, None);
        assert!(!l.retire_cell(42, request, true));
        assert!(!l.retire_cell(42, moved_request, true));
        l.offset = 0.0;
        l.update_window(&mut Vec::new(), None);
        assert_eq!(l.focused, None);
        assert!(!l.retire_cell(42, request, true));
        assert_eq!(l.slots[0].native, NativeCell::Retiring(source_request));
        assert!(!l.free.contains(&0));
        assert!(!l.retire_cell(42, source_request, false));
        l.focus_cell(Some(42));
        l.projected(42);
        assert_eq!(l.focused, None);
        assert_eq!(l.slots[0].native, NativeCell::Retiring(source_request));
        assert!(l.retire_cell(42, source_request, true));
        assert_eq!(l.slots[0].native, NativeCell::Detached);
    }

    #[test]
    fn measurements_shift_offsets_and_anchor_above_viewport() {
        let mut l = list(100, 50.0, 400.0);
        l.offset = 1000.0;
        // Item 0 is above the viewport: growing it must scroll by the same.
        assert_eq!(l.measured(0, 80.0), 30.0);
        assert_eq!(l.item_at(1), 80.0);
        assert_eq!(l.blocks().total, 100.0 * 50.0 + 30.0);
        // Item 30 is in view: no anchoring.
        assert_eq!(l.measured(30, 10.0), 0.0);
    }

    #[test]
    fn load_more_fires_once_per_count() {
        let mut l = list(10, 50.0, 400.0);
        let mut binds = Vec::new();
        assert!(
            l.update_window(&mut binds, None).end,
            "500 px of content in a 400 px viewport"
        );
        assert!(!l.update_window(&mut binds, None).end);
        l.set_count(20);
        l.offset = 600.0;
        assert!(l.update_window(&mut binds, None).end);
    }

    #[test]
    fn load_more_at_start_fires_once_per_approach_after_a_scroll() {
        let mut l = list(100, 50.0, 400.0);
        let mut binds = Vec::new();
        // Where the list opens is not an approach.
        assert!(!l.update_window(&mut binds, None).start);
        // The user scrolls away, then back within a viewport of the start.
        l.reported(2000.0, 0);
        assert!(!l.update_window(&mut binds, None).start);
        l.reported(300.0, 0);
        assert!(l.update_window(&mut binds, None).start);
        // Once: scrolling on near the start fires nothing more.
        l.reported(100.0, 0);
        assert!(!l.update_window(&mut binds, None).start);
        // A page arrives at the start: the visible rows keep their place,
        // still within the threshold, so the list asks again.
        l.splice(0, 0, 2);
        assert_eq!(l.offset, 200.0);
        assert!(l.update_window(&mut binds, None).start);
        assert!(!l.update_window(&mut binds, None).start);
        // Out and back in: a new approach.
        l.reported(1500.0, 0);
        assert!(!l.update_window(&mut binds, None).start);
        l.reported(0.0, 0);
        assert!(l.update_window(&mut binds, None).start);
        // The threshold, in viewports.
        let mut t = list(100, 50.0, 400.0);
        t.start_threshold = 0.25;
        t.reported(150.0, 0);
        assert!(!t.update_window(&mut binds, None).start);
        t.reported(100.0, 0);
        assert!(t.update_window(&mut binds, None).start);
    }

    #[test]
    fn load_more_at_start_fires_where_a_scroll_command_lands() {
        // `initialScrollIndex` near the start: the app put the list there.
        let mut l = list(100, 50.0, 400.0);
        let target = PinTarget::Index {
            index: 2,
            view_position: 0.0,
            view_offset: 0.0,
        };
        let offset = l.target_offset(target);
        l.pin(Some(target), offset, false, false);
        l.jump(offset);
        let mut binds = Vec::new();
        assert!(l.update_window(&mut binds, None).start);
    }

    #[test]
    fn inverted_lists_load_at_their_start_and_keep_the_visible_rows() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.loads_at_start = true;
        l.anchor_end();
        let mut binds = Vec::new();
        // Opens at its start (item 0 at the bottom): no event.
        assert!(!l.update_window(&mut binds, None).start);
        // Scrolled up, then back down to 200 px from the start.
        l.reported(5000.0 - 400.0 - 1000.0, 0);
        assert!(!l.update_window(&mut binds, None).start);
        l.reported(5000.0 - 400.0 - 200.0, 0);
        assert!(l.update_window(&mut binds, None).start);
        // Newer items arrive before item 0: the rows on screen stay.
        let on_screen = |l: &ListState, i: u32| l.to_content(l.item_at(i), 50.0) - l.offset;
        let before = on_screen(&l, 4);
        l.splice(0, 0, 4);
        let scrolled = l.take_splice_anchor() + l.anchor_end();
        assert_eq!(scrolled, 0.0);
        assert_eq!(on_screen(&l, 8), before);
        // So does their measuring.
        let offset = l.offset;
        let anchor = l.measured(0, 80.0);
        l.offset += anchor;
        assert_eq!(anchor + l.anchor_end(), 0.0);
        assert_eq!(l.offset, offset);
        // A forwarded parent correction shares the same inverted integral
        // contract; returning that measured row to its old size cancels too.
        let offset = l.offset;
        let anchor = l.measured(0, 50.0);
        assert_eq!(anchor, 30.0);
        l.anchor_by(anchor);
        assert_eq!(anchor + l.anchor_end(), 0.0);
        assert_eq!(l.offset, offset);
        assert_eq!(on_screen(&l, 8), before);
        // At the start, what arrives there shows (a chat's new message).
        let mut c = list(100, 50.0, 400.0);
        c.set_inverted(true);
        c.loads_at_start = true;
        c.anchor_end();
        c.splice(0, 0, 1);
        c.take_splice_anchor();
        c.anchor_end();
        assert_eq!(c.natural_offset(), 0.0);
        // Without `onLoadMoreAtStart`, an inverted list keeps its distance
        // from the end wherever it is, as it always did.
        let mut d = list(100, 50.0, 400.0);
        d.set_inverted(true);
        d.anchor_end();
        d.reported(5000.0 - 400.0 - 200.0, 0);
        d.splice(0, 0, 4);
        assert_eq!(d.take_splice_anchor(), 0.0);
        d.anchor_end();
        assert_eq!(d.natural_offset(), 200.0);
    }

    #[test]
    fn shrinking_count_unbinds() {
        let mut l = list(100, 50.0, 400.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        l.set_count(3);
        binds.clear();
        l.update_window(&mut binds, None);
        assert_eq!(l.slots.iter().filter(|s| s.index.is_some()).count(), 3);
    }

    #[test]
    fn columns_share_rows() {
        let mut l = list(10, 50.0, 1000.0);
        l.set_columns(3);
        // 4 rows of 50.
        assert_eq!(l.blocks().total, 200.0);
        assert_eq!(l.item_at(4), 50.0);
        assert_eq!(l.column_of(4), 1);
        // A row is as tall as its tallest item.
        l.measured(4, 80.0);
        assert_eq!(l.item_at(6), 130.0);
        assert_eq!(l.column(320.0, 2), (320.0 * 2.0 / 3.0, 320.0 / 3.0));
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.len(), 10);
    }

    #[test]
    fn padding_gaps_and_extras() {
        let mut l = list(3, 50.0, 1000.0);
        l.set_content(ListContentStyle {
            padding: EdgeInsets {
                top: px(10.0),
                right: px(16.0),
                bottom: px(20.0),
                left: px(16.0),
            },
            row_gap: px(8.0),
            column_gap: px(0.0),
        });
        l.add_slot_cell(CellSlot::Header, 7);
        l.measured_extra(ExtraKind::Header, 30.0);
        l.add_slot_cell(CellSlot::Footer, 8);
        l.measured_extra(ExtraKind::Footer, 40.0);
        let b = l.blocks();
        assert_eq!(b.header, 10.0);
        assert_eq!(b.body, 10.0 + 30.0 + 8.0);
        // Three items with two gaps between them.
        assert_eq!(b.footer, b.body + 3.0 * 50.0 + 2.0 * 8.0 + 8.0);
        assert_eq!(b.total, b.footer + 40.0 + 20.0);
        assert_eq!(l.full_width(400.0), (16.0, 368.0));
        // No items: the empty placeholder takes their place.
        l.set_count(0);
        l.add_slot_cell(CellSlot::Empty, 9);
        l.measured_extra(ExtraKind::Empty, 100.0);
        let b = l.blocks();
        assert_eq!(b.footer, b.body + 100.0 + 8.0);
    }

    #[test]
    fn lists_follow_the_end_within_the_threshold() {
        let mut l = list(100, 50.0, 400.0);
        l.set_follow_end(Some(10.0));
        assert_eq!(l.anchor_end(), 0.0, "starts where it is");
        // At the end: the last item grows by 30, the list follows.
        l.offset = 5000.0 - 400.0;
        l.measured(99, 80.0);
        assert_eq!(l.anchor_end(), 30.0);
        assert_eq!(l.offset, 5030.0 - 400.0);
        // Scrolled up: it grows below what is visible, which stays.
        l.offset = 1000.0;
        l.measured(99, 120.0);
        assert_eq!(l.anchor_end(), 0.0);
        assert_eq!(l.offset, 1000.0);
        // A child list first corrects overestimated rows above the reader;
        // its remaining rows then make the containing row taller overall.
        let mut child = list(20, 50.0, 400.0);
        child.set_follow_end(Some(10.0));
        child.anchor_end();
        child.reported(600.0, 0);
        child.anchor_by(-100.0);
        child.measured(19, 250.0);
        assert_eq!(child.anchor_end(), 300.0);
        assert_eq!(child.offset, 800.0);

        // An insertion before a reader well away from the end keeps its
        // source in view; the correction itself is no reason to follow end.
        let mut prepended = list(20, 50.0, 400.0);
        prepended.set_follow_end(Some(10.0));
        prepended.anchor_end();
        prepended.reported(100.0, 0);
        prepended.splice(0, 0, 12);
        assert_eq!(prepended.offset, 700.0);
        assert_eq!(prepended.take_splice_anchor(), 600.0);
        assert_eq!(prepended.anchor_end(), 0.0);
        assert_eq!(prepended.offset, 700.0);

        // Without the option, nothing follows.
        let mut m = list(100, 50.0, 400.0);
        m.anchor_end();
        m.offset = 5000.0 - 400.0;
        m.measured(99, 80.0);
        assert_eq!(m.anchor_end(), 0.0);
    }

    #[test]
    fn inverted_lists_start_at_the_end_and_keep_their_distance_from_it() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        // Starts scrolled to the end; item 0 is at the bottom.
        assert_eq!(l.anchor_end(), 5000.0 - 400.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 4950.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.first().map(|b| b.1), Some(0));
        assert!(binds.iter().all(|b| b.1 <= 16));
        // Older items load (appended): the visible content stays put.
        l.set_count(120);
        assert_eq!(l.anchor_end(), 1000.0);
        assert_eq!(l.offset, 5600.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 5950.0);
        // A short list sits at the bottom.
        let mut s = list(2, 50.0, 400.0);
        s.set_inverted(true);
        s.anchor_end();
        assert_eq!(s.offset, 0.0);
        assert_eq!(s.to_content(s.item_at(0), 50.0), 350.0);
    }

    #[test]
    fn sticky_items_stick_at_their_offset() {
        let mut l = list(100, 50.0, 400.0);
        l.set_sticky(vec![0, 30]);
        l.set_sticky_offset(20.0);
        // Ranges are scroll offsets: item 0 is pinned 20 from the top from
        // the start (pushed down by 20), item 30 from 1480 on; 30 pushes 0
        // out when it reaches 0's end, 50 below the offset.
        assert_eq!(
            l.sticky_range(0, 1, 50.0),
            StickyRange {
                cell: 1,
                start: -20.0,
                end: 1430.0,
                offset: None,
            }
        );
        assert_eq!(l.sticky_range(30, 2, 50.0).start, 1480.0);
        // The pinned item is the last one that reached the offset.
        l.offset = 1470.0;
        assert_eq!(l.active_sticky(), Some(0));
        l.offset = 1480.0;
        assert_eq!(l.active_sticky(), Some(30));
        // Without it again: as before.
        l.set_sticky_offset(0.0);
        assert_eq!(l.sticky_range(0, 1, 50.0).start, 0.0);
        assert_eq!(l.active_sticky(), Some(0));
        // A negative offset sticks items partly out of view.
        l.set_sticky_offset(-10.0);
        assert_eq!(l.sticky_range(30, 2, 50.0).start, 1510.0);
    }

    #[test]
    fn sticky_items_stay_rendered_and_travel_until_the_next() {
        let mut l = list(100, 50.0, 400.0);
        l.set_sticky(vec![30, 0]);
        l.offset = 1000.0;
        assert_eq!(l.active_sticky(), Some(0));
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert!(binds.iter().any(|b| b.1 == 0), "{binds:?}");
        assert_eq!(
            l.sticky_range(0, 1, 50.0),
            StickyRange {
                cell: 1,
                start: 0.0,
                end: 1450.0,
                offset: None,
            }
        );
        assert_eq!(l.sticky_range(30, 1, 50.0).end, f32::INFINITY);
        l.offset = 1600.0;
        assert_eq!(l.active_sticky(), Some(30));
    }

    #[test]
    fn the_sticky_item_before_the_pinned_one_stays_rendered() {
        let mut l = list(100, 50.0, 400.0);
        l.set_sticky(vec![0, 30, 60]);
        // 60 is pinned; 30 starts at 1500, far above the rendered window.
        l.offset = 3200.0;
        assert_eq!(l.active_sticky(), Some(60));
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        let bound = |l: &ListState, i: u32| l.slots.iter().any(|s| s.index == Some(i));
        assert!(bound(&l, 60) && bound(&l, 30), "{binds:?}");
        assert!(!bound(&l, 0));
        // Scrolled back into 30's rows: 30 is pinned and 0 waits above it.
        l.offset = 2000.0;
        binds.clear();
        l.update_window(&mut binds, None);
        assert!(bound(&l, 30) && bound(&l, 0), "{binds:?}");
        assert!(!bound(&l, 60));
    }

    #[test]
    fn viewability_thresholds() {
        let mut l = list(100, 100.0, 400.0);
        l.offset = 50.0;
        // Any visible pixel: items 0..=4.
        assert_eq!(l.viewable_items(), Some((0, 4)));
        l.viewability.item_visible_percent = Some(60.0);
        assert_eq!(l.viewable_items(), Some((1, 3)));
        l.viewability.item_visible_percent = Some(50.0);
        assert_eq!(l.viewable_items(), Some((0, 4)));
    }

    #[test]
    fn stale_offset_reports_keep_pending_scrolls() {
        let mut l = list(100, 50.0, 400.0);
        l.offset = 500.0;
        l.issue_scroll_by(30.0);
        // Reported before the platform applied the shift.
        l.reported(500.0, 0);
        assert_eq!(l.offset, 530.0);
        l.issue_scroll_to(1000.0);
        l.reported(531.0, 1);
        assert_eq!(l.offset, 1000.0);
        l.reported(1002.0, 2);
        assert_eq!(l.offset, 1002.0);
        assert!(l.pending.is_empty());
    }

    #[test]
    fn extras_at_the_top_do_not_scroll_the_list() {
        let mut l = list(0, 50.0, 400.0);
        l.add_slot_cell(CellSlot::Empty, 3);
        assert_eq!(l.measured_extra(ExtraKind::Empty, 65.0), 0.0);
        let mut l = list(100, 50.0, 400.0);
        l.add_slot_cell(CellSlot::Header, 3);
        assert_eq!(l.measured_extra(ExtraKind::Header, 30.0), 0.0);
        // Scrolled past it: the visible content keeps its place.
        l.offset = 500.0;
        assert_eq!(l.measured_extra(ExtraKind::Header, 40.0), 10.0);
        // Inverted lists anchor to their end instead.
        l.set_inverted(true);
        assert_eq!(l.measured_extra(ExtraKind::Header, 50.0), 0.0);
    }

    #[test]
    fn splices_keep_measurements_cells_and_the_visible_content() {
        let mut l = list(100, 50.0, 400.0);
        let mut binds = Vec::new();
        l.offset = 1000.0;
        l.update_window(&mut binds, None);
        for (slot, index) in binds.drain(..) {
            l.add_slot_cell(CellSlot::Item(slot), 100 + slot);
            l.rendered(100 + slot, index);
        }
        l.measured(25, 80.0);
        // Three items arrive at the top: item 20 (the first visible) keeps
        // its place on screen.
        let before = l.item_at(20) - l.offset;
        l.splice(0, 0, 3);
        assert_eq!(l.count, 103);
        assert_eq!(l.item_at(23) - l.offset, before);
        assert_eq!(l.take_splice_anchor(), 150.0);
        // Item 25's measurement moved with it.
        assert_eq!(l.row_extent(28), 80.0);
        // Cells follow their items, and the runtime is told.
        l.update_window(&mut binds, None);
        assert!(binds.iter().any(|&(_, i)| i == 28));
        assert!(l.slots.iter().any(|s| s.ready() == Some(28)));
        // A change below the viewport moves nothing.
        let offset = l.offset;
        l.splice(90, 2, 0);
        assert_eq!(l.offset, offset);
        assert_eq!(l.count, 101);
    }

    #[test]
    fn batched_splices_bind_only_the_final_source_indices() {
        let mut l = list(2, 50.0, 400.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds, [(0, 0), (1, 1)]);
        binds.clear();
        // Both mutations are published together: the runtime sees only
        // the final one-row snapshot, never the intermediate three rows.
        l.splice(0, 0, 1);
        l.splice(0, 3, 1);
        l.update_window(&mut binds, None);
        assert_eq!(binds, [(1, 0)]);

        // A surviving moved cell still needs its final index, not each
        // intermediate index from consecutive prepends.
        binds.clear();
        l.splice(0, 0, 1);
        l.splice(0, 0, 1);
        l.update_window(&mut binds, None);
        assert_eq!(
            binds
                .iter()
                .filter(|&&(slot, _)| slot == 1)
                .copied()
                .collect::<Vec<_>>(),
            [(1, 2)]
        );
        assert!(
            binds
                .iter()
                .all(|&(slot, index)| l.slots[slot as usize].index == Some(index))
        );
    }

    #[test]
    fn paced_batched_splices_discard_bindings_for_replaced_sources() {
        let mut l = list(100, 50.0, 400.0);
        l.paced = true;
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.len(), 8);
        assert!(l.has_paced());
        binds.clear();

        // Both changes publish together. Previously requested cells and
        // overscan cells still waiting must read only the final snapshot.
        l.splice(0, 0, 1);
        l.splice(0, 101, 2);
        l.update_window(&mut binds, None);
        // The prepend moved the viewport to 50: final row 1 is visible,
        // while row 0 is overscan above it and must wait for paced work.
        assert_eq!(binds.iter().map(|b| b.1).collect::<Vec<_>>(), [1]);
        assert_eq!(l.take_paced(100, &mut binds), 1);
        assert_eq!(binds.iter().map(|b| b.1).collect::<Vec<_>>(), [1, 0]);
        assert!(
            binds
                .iter()
                .all(|&(slot, index)| l.slots[slot as usize].requested == Some(index))
        );
        assert!(!l.has_paced());
        binds.clear();

        // An empty final source must not receive even a moved-cell bind.
        l.splice(0, 0, 2);
        l.splice(0, 4, 0);
        l.update_window(&mut binds, None);
        l.take_paced(100, &mut binds);
        assert!(binds.is_empty());
        assert!(!l.has_paced());
    }

    #[test]
    fn paced_lists_bind_the_viewport_now_and_the_overscan_ahead_first() {
        let mut l = list(1000, 50.0, 400.0);
        l.paced = true;
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (0..8).collect::<Vec<_>>(), "the viewport");
        assert!(l.has_paced());
        binds.clear();
        assert_eq!(l.take_paced(3, &mut binds), 3);
        assert_eq!(binds.iter().map(|b| b.1).collect::<Vec<_>>(), [8, 9, 10]);
        while l.take_paced(100, &mut binds) > 0 {}
        assert!(!l.has_paced());

        // The platform reports the scroll: scrolling up by 100, the
        // viewport and two steps above it bind now; the rest above comes
        // before what is below.
        l.reported(2000.0, 0);
        l.update_window(&mut binds, None);
        while l.take_paced(100, &mut binds) > 0 {}
        l.reported(1900.0, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        // 1700..2300 was bound already; 1500..1600 is new and waits.
        assert_eq!(binds, []);
        // A jump binds its viewport only.
        l.reported(5000.0, 0);
        l.update_window(&mut binds, None);
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (100..108).collect::<Vec<_>>());
        // A step up before the overscan bound: the viewport (4900..5300)
        // and two steps ahead (4700..4900) bind now ...
        l.reported(4900.0, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (94..100).collect::<Vec<_>>());
        // ... the rest above before what is below.
        binds.clear();
        l.take_paced(3, &mut binds);
        assert_eq!(binds.iter().map(|b| b.1).collect::<Vec<_>>(), [93, 92, 91]);
    }

    #[test]
    fn splices_tell_bound_cells_their_index_and_forget_gone_items() {
        let mut l = list(100, 50.0, 400.0);
        l.paced = true;
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        for &(slot, index) in &binds {
            l.add_slot_cell(CellSlot::Item(slot), 100 + slot);
            l.rendered(100 + slot, index);
        }
        // Overscan cells wait; one row arrives at the top.
        l.splice(0, 0, 1);
        binds.clear();
        l.update_window(&mut binds, None);
        // Every bound cell learns its new index, at once (the anchoring
        // scroll keeps them in place). The anchoring scroll is the core's,
        // not a step of the user's: the cells waiting below it, and the new
        // row above, still wait.
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (1..=8).collect::<Vec<_>>(), "{binds:?}");
        assert!(l.has_paced());
        // The data shrinks under the cells still waiting: none is asked
        // for an item that is gone.
        l.splice(3, 98, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        while l.take_paced(100, &mut binds) > 0 {}
        assert!(binds.iter().all(|&(_, i)| i < 3), "{binds:?}");
    }

    #[test]
    fn pins_follow_until_landed_measured_or_scrolled_away() {
        let mut l = list(100, 50.0, 400.0);
        // An animated scroll to the end: retargeted when the end moves,
        // corrected once it landed.
        l.pin(Some(PinTarget::End), 4600.0, true, false);
        l.issue_scroll_to(4600.0);
        l.measured(99, 90.0);
        assert_eq!(
            l.follow_pin(0.0),
            Follow::To {
                offset: 4640.0,
                animated: true
            }
        );
        l.issue_scroll_to(4640.0);
        l.reported(3000.0, 2);
        assert!(l.pinned(), "in flight");
        l.reported(4640.0, 2);
        l.measured(98, 60.0);
        assert_eq!(l.follow_pin(0.0), Follow::By(10.0));
        assert_eq!(l.offset, 4650.0);
        assert!(l.pinned(), "rows in the viewport not measured yet");
        // The user scrolls away: the pin ends.
        l.reported(4000.0, 2);
        assert!(!l.pinned());
        // Splices end it too.
        l.pin(Some(PinTarget::End), 4650.0, false, false);
        l.splice(0, 1, 0);
        assert!(!l.pinned());

        // Forwarded relative correction shifts a running native animation's
        // destination too; the owner must not retarget that same change.
        let mut l = list(100, 50.0, 400.0);
        l.pin(Some(PinTarget::End), 4600.0, true, false);
        l.issue_scroll_to(4600.0);
        l.measured(99, 70.0);
        l.anchor_by(20.0);
        l.issue_scroll_by(20.0);
        assert_eq!(l.follow_pin(0.0), Follow::Stay);
        l.reported(4620.0, 2);
        l.measured(98, 60.0);
        assert_eq!(l.follow_pin(0.0), Follow::By(10.0));
    }

    /// A list in its parent's viewport, 100 rows of 50, starting `start`
    /// down a page of `max + 400` in a 400 pt viewport scrolled to
    /// `offset`.
    fn in_page(start: f32, offset: f32, max: f32) -> ListState {
        let mut l = list(100, 50.0, 0.0);
        l.set_parent(true);
        l.set_outer(start, offset, 400.0, max, true);
        l
    }

    fn bound(l: &ListState) -> Vec<u32> {
        let mut bound: Vec<u32> = l.slots.iter().filter_map(|s| s.index).collect();
        bound.sort_unstable();
        bound
    }

    #[test]
    fn in_a_page_the_window_is_the_viewport_over_the_list() {
        // The list starts 100 below the viewport's top: its offset is
        // -100, and the rows from its start to 700 (the viewport and the
        // overscan below it) render.
        let mut l = in_page(100.0, 0.0, 4700.0);
        assert_eq!(l.offset, -100.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(bound(&l), (0..=14).collect::<Vec<_>>());
        // Entirely below the viewport and its overscan: nothing.
        let mut l = in_page(1000.0, 0.0, 4700.0);
        l.update_window(&mut binds, None);
        assert!(bound(&l).is_empty());
        // Scrolled past: nothing either.
        let mut l = in_page(0.0, 5500.0, 6000.0);
        l.update_window(&mut binds, None);
        assert!(bound(&l).is_empty());
    }

    #[test]
    fn in_a_page_load_more_fires_as_the_lists_end_nears() {
        // 20 rows (1000) below a 1000 pt header.
        let mut l = list(20, 50.0, 0.0);
        l.set_parent(true);
        let mut binds = Vec::new();
        for (offset, fires) in [(0.0, false), (1100.0, false), (1300.0, true)] {
            l.set_outer(1000.0, offset, 400.0, 1600.0, true);
            assert_eq!(l.update_window(&mut binds, None).end, fires, "at {offset}");
        }
    }

    #[test]
    fn in_a_page_only_changes_above_the_viewport_scroll_it() {
        // The list's start shows: rows growing move what is below them.
        let mut l = in_page(100.0, 0.0, 4700.0);
        assert_eq!(l.measured(0, 80.0), 0.0);
        l.splice(0, 0, 3);
        assert_eq!(l.take_splice_anchor(), 0.0);
        // Scrolled 1000 into it: a row above the viewport keeps the visible
        // rows in place, one in it does not.
        let mut l = in_page(100.0, 1100.0, 4700.0);
        assert_eq!(l.offset, 1000.0);
        assert_eq!(l.measured(2, 80.0), 30.0);
        assert_eq!(l.measured(25, 80.0), 0.0);
        l.splice(0, 0, 2);
        assert_eq!(l.take_splice_anchor(), 100.0);
    }

    #[test]
    fn in_a_page_scroll_targets_are_clamped_by_the_page() {
        // The page scrolls 4700: from the list's start, 100 down, it
        // reaches -100 to 4600 of the list.
        let l = in_page(100.0, 0.0, 4700.0);
        assert_eq!(l.offset_for_index(10, 0.0, 0.0), 500.0);
        assert_eq!(l.offset_for_index(99, 0.0, 0.0), 4600.0);
        assert_eq!(l.offset_for_index(0, 1.0, 0.0), -100.0);
        // The end of the list at the end of the viewport.
        assert_eq!(l.end_offset(), 4600.0);
        assert_eq!(l.clamped(-500.0), -100.0);
    }

    #[test]
    fn in_a_page_what_needs_a_scroll_view_of_its_own_is_off() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.set_sticky(vec![0]);
        l.set_parent(true);
        // Sticky rows stay: they stick to the view around the list.
        assert!(!l.inverted && l.sticky_enabled());
        assert_eq!(l.ignored, ignored::INVERTED);
        l.set_follow_end(Some(10.0));
        assert_eq!(l.follow_end, None);
        assert_ne!(l.ignored & ignored::FOLLOW_END, 0);
    }

    #[test]
    fn back_to_its_own_scroll_view_a_list_gets_back_what_parent_mode_set_aside() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.set_follow_end(Some(10.0));
        l.set_parent(true);
        l.set_parent(false);
        assert!(l.inverted);
        assert_eq!(l.follow_end, Some(10.0));
    }

    #[test]
    fn in_a_page_sticky_rows_travel_in_the_pages_offsets_to_the_lists_end() {
        // 100 rows of 50 from 100 down the page; rows 0 and 30 stick 20
        // below its top.
        let mut l = in_page(100.0, 0.0, 4700.0);
        l.set_sticky(vec![0, 30]);
        l.set_sticky_offset(20.0);
        // Row 0 sticks from 80 (its 100 less 20) until row 30 pushes it out.
        assert_eq!(
            l.sticky_range(0, 1, 50.0),
            StickyRange {
                cell: 1,
                start: 80.0,
                end: 100.0 + 1500.0 - 50.0 - 20.0,
                offset: None,
            }
        );
        // The last one stops with its bottom at the list's end (5100).
        let last = l.sticky_range(30, 2, 50.0);
        assert_eq!(last.start, 100.0 + 1500.0 - 20.0);
        assert_eq!(last.end, 100.0 + 5000.0 - 50.0 - 20.0);
        // Pinned in list coordinates, as in a list of its own.
        l.set_outer(100.0, 1700.0, 400.0, 4700.0, true);
        assert_eq!(l.active_sticky(), Some(30));
    }

    #[test]
    fn in_a_page_a_pin_survives_the_list_moving_in_the_page() {
        let mut l = in_page(100.0, 600.0, 4700.0);
        l.pin(
            Some(PinTarget::Index {
                index: 10,
                view_position: 0.0,
                view_offset: 0.0,
            }),
            500.0,
            false,
            false,
        );
        // A header above the list grows by 40: the page did not scroll,
        // the list moved.
        l.set_outer(140.0, 600.0, 400.0, 4740.0, true);
        assert!(l.pinned());
        // The user scrolls.
        l.set_outer(140.0, 900.0, 400.0, 4740.0, true);
        assert!(!l.pinned());
    }

    #[test]
    fn scroll_to_index() {
        let mut l = list(100, 50.0, 400.0);
        assert_eq!(l.offset_for_index(10, 0.0, 0.0), 500.0);
        assert_eq!(l.offset_for_index(10, 0.5, 0.0), 500.0 - 175.0);
        assert_eq!(l.offset_for_index(99, 0.0, 0.0), 5000.0 - 400.0);
        l.set_inverted(true);
        // Item 0 at the bottom of the viewport.
        assert_eq!(l.offset_for_index(0, 0.0, 0.0), 4600.0);
    }
}
