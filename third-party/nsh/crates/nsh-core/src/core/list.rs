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
//! ahead of it in the scroll direction, as far as the next few frames of
//! the scroll go ([`URGENT_STEPS`]): the rows bound now reach the screen a
//! frame or two later, after the engine's turn and the main thread's. A list with `paced` set (the
//! runtime's) leaves the rest of the overscan pending: the engine binds it
//! with `take_paced`, nearest the leading edge first, as its per-turn
//! budget allows, and asks for a display frame while some is left.
//!
//! Row-local state travels with recycled cells, so
//! apps keep it outside, keyed by id. Unbound cells keep their last content:
//! the core moves those in the render window out of sight (never with a NaN
//! frame; cells never placed are skipped) and hides them from touches and
//! screen readers until they are placed again (`Core::set_spare`). The
//! header, footer and empty placeholder are cells with a role
//! (`slot="header"`, ...) and are never recycled. Each cell is a Taffy root
//! of its own (its width follows the list's cross axis), so scrolling
//! relays out dirty cells only.
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

use rustc_hash::FxHashMap;

use crate::{
    fenwick::Fenwick,
    ops::{CellSlot, ListAlignment, ListContentStyle, Viewability},
    text_source::{SourceGeometry, SourcePoint, SourcePosition},
};

/// How far beyond the viewport cells are kept rendered, in viewports.
const OVERSCAN: f32 = 1.0;
/// How many of the scroll's recent steps ahead of the viewport bind with
/// the window, not paced: the rows a commit binds show a frame after the
/// report at best (the engine's turn, then the main thread's), two or three
/// when either is busy, and a fling's steps grow and come unevenly (wheel
/// notches, touchpad events bunched into frames). Rows enter this span a
/// step's worth per frame however long it is, so a longer one costs only
/// when a scroll speeds up.
const URGENT_STEPS: f32 = 4.0;
/// What the step [`ListState::urgent_span`] reads keeps of a longer one
/// before it, per report, while the scroll goes the same way: one slow
/// frame between fast ones does not shrink the span.
const LEAD_DECAY: f32 = 0.75;
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

/// The step [`ListState::urgent_span`] reads after the platform reported a
/// move of `step` (natural coordinates): the move itself, unless a longer
/// recent one in the same direction outlasts it, decayed by [`LEAD_DECAY`].
/// A jump (longer than the viewport) is not kept: the steps after it bind
/// ahead again at once.
fn next_lead(lead: f32, step: f32, viewport: f32) -> f32 {
    let kept = lead.abs() * LEAD_DECAY;
    if step.signum() == lead.signum() && lead.abs() <= viewport && kept > step.abs() {
        lead.signum() * kept
    } else {
        step
    }
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
    alignment: ListAlignment,
}

/// Props a list in its parent's viewport ignores, each warned of once.
pub(super) mod ignored {
    pub(crate) const INVERTED: u16 = 1 << 0;
    pub(crate) const FOLLOW_END: u16 = 1 << 1;
    pub(crate) const ALIGNMENT: u16 = 1 << 2;
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
    pub(super) extras: [Extra; 3],
    /// Padding and gaps: `contentStyle`, else `contentClass`'s.
    pub(super) content: ListContentStyle,
    /// `contentStyle` as set.
    content_style: ListContentStyle,
    /// What `contentClass` sets.
    content_class: ListContentStyle,
    pub(super) horizontal: bool,
    /// Shown mirrored (a horizontal list right to left): laid out left to
    /// right, so the content's left padding is its main axis' end.
    mirrored: bool,
    pub(super) inverted: bool,
    /// `maintainVisibleContentPosition`'s `autoscrollToBottomThreshold`:
    /// a list that is not inverted follows the end of its content while
    /// it is within this distance of it.
    pub(super) follow_end: Option<f32>,
    /// Where the list rests ([`ListAlignment`]; an inverted list ignores it).
    pub(super) alignment: ListAlignment,
    /// `stickyHeaderIndices`, sorted.
    pub(super) sticky: Vec<u32>,
    /// Items kept rendered wherever they are (`Core::sync_kept`): those
    /// holding the keyboard focus, an open overlay or an end of a text
    /// selection, which must outlive scrolling away.
    kept: Vec<u32>,
    /// `stickyHeaderOffset`: sticky items stick this far from the
    /// viewport's start.
    sticky_offset: f32,
    /// `stickyHeaderOffset` as an animated value: added to `sticky_offset`
    /// by the platforms as they pin (a header that moves).
    sticky_node: Option<crate::animation::NodeId>,
    /// Sticky ranges last sent to the platform.
    pub(super) sent_sticky: Vec<StickyRange>,
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
    /// What this layout's measurements asked to scroll so far (the `kept`
    /// that `anchor_end` gets), not yet in `offset`.
    measured_scroll: f32,
    /// Scrolls issued to the platform (`ScrollBy` items and `ScrollTo`
    /// commands); platforms count the ones they applied.
    issued: u32,
    /// Issued scrolls by number, oldest first, until a report shows them
    /// applied.
    pending: Vec<(u32, PendingScroll)>,
    /// Cells whose item moved to another index (a splice): the runtime
    /// learns their new index with the next bindings.
    moved: Vec<(u32, u32)>,
    /// The items changed (a splice, a new count) since the core last
    /// hid the cells without an item: the rows those show may be gone.
    pub(super) items_changed: bool,
    /// Binds of overscan cells wait for the engine's budget
    /// ([`Self::take_paced`]); the rest bind with the window.
    pub(super) paced: bool,
    /// The scroll step the platform reported last, in natural coordinates
    /// (its sign is the scroll direction), or a longer recent one in the
    /// same direction, decayed ([`LEAD_DECAY`]). The core's own moves
    /// (anchoring a splice, measured rows, following a pin) are not steps.
    lead: f32,
    /// Scroll that keeps the visible content in place after a splice or a
    /// change of columns.
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
    interaction: Option<u16>,
    /// The item the last change of columns kept at the top: while its row
    /// is still the first visible one, the next change keeps it rather than
    /// the row's first item, so resizing back and forth does not drift.
    columns_anchor: Option<u32>,
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
    pub(super) fn new() -> Self {
        Self {
            count: 0,
            estimated: 50.0,
            columns: 1,
            sizes: Vec::new(),
            rows: Fenwick::default(),
            slots: Vec::new(),
            by_index: FxHashMap::default(),
            free: Vec::new(),
            extras: [Extra::NONE; 3],
            mirrored: false,
            content: ListContentStyle::default(),
            content_style: ListContentStyle::default(),
            content_class: ListContentStyle::default(),
            horizontal: false,
            inverted: false,
            follow_end: None,
            alignment: ListAlignment::Top,
            sticky: Vec::new(),
            kept: Vec::new(),
            sticky_offset: 0.0,
            sticky_node: None,
            sent_sticky: Vec::new(),
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
            measured_scroll: 0.0,
            issued: 0,
            pending: Vec::new(),
            moved: Vec::new(),
            items_changed: false,
            paced: false,
            lead: 0.0,
            splice_anchor: 0.0,
            pin: None,
            source_geometry: SourceGeometry::default(),
            source_rows: None,
            source_dirty: false,
            automatic: false,
            interaction: None,
            columns_anchor: None,
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
                alignment: std::mem::take(&mut self.alignment),
            };
            if set_aside.inverted {
                self.ignored |= ignored::INVERTED;
            }
            if set_aside.follow_end.is_some() {
                self.ignored |= ignored::FOLLOW_END;
            }
            if set_aside.alignment != ListAlignment::Top {
                self.ignored |= ignored::ALIGNMENT;
            }
            self.set_aside = Some(Box::new(set_aside));
        } else if let Some(set_aside) = self.set_aside.take() {
            let SetAside {
                inverted,
                follow_end,
                alignment,
            } = *set_aside;
            self.inverted = inverted;
            self.follow_end = follow_end;
            self.alignment = alignment;
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
    /// stay, and when the change is above the first visible item of a list
    /// scrolled past its start, the visible content keeps its place
    /// ([`Self::visible_anchor`]).
    pub(super) fn splice(&mut self, at: u32, removed: u32, inserted: u32) {
        let at = at.min(self.count);
        let removed = removed.min(self.count - at);
        if removed == 0 && inserted == 0 {
            return;
        }
        self.items_changed = true;
        // The visible content keeps its place instead.
        if !matches!(self.pin, Some(Pin::Reading { .. })) {
            self.pin = None;
        }
        self.source_dirty |= !self.source_geometry.is_empty();
        let anchor = self.visible_anchor();
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
        self.kept = self.kept.iter().filter_map(|&i| shift(i)).collect();
        self.by_index.clear();
        for (slot, s) in self.slots.iter_mut().enumerate() {
            let index = s.index.and_then(shift);
            let Some(new) = index else {
                if s.index.take().is_some() {
                    self.free.push(slot as u32);
                } else if let (Some(r), Some(n)) = (s.requested, s.requested.and_then(shift))
                    && s.rendered == Some(r)
                {
                    // A free cell still showing an item that stays follows
                    // it (the runtime is told), so the item gets it back.
                    s.requested = Some(n);
                    s.rendered = Some(n);
                    if n != r {
                        self.moved.push((slot as u32, n));
                    }
                    continue;
                }
                // The cell's content follows the new data at its old index:
                // it is bound again before it shows.
                s.rendered = None;
                s.requested = None;
                continue;
            };
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
        if removed == 0 && at + inserted == self.count {
            // Appended: the rows before stay as they are.
            self.resize_rows(at);
        } else {
            self.rebuild_offsets();
        }
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
                self.keep_in_place(moved_to, from_top);
            }
        }
    }

    /// The first visible item and where it is in the viewport, for a
    /// change that should keep it in place: only while the list is
    /// scrolled past its start, as a browser's scroll anchoring. At the
    /// start, rows that arrive above the first show and push it down (a
    /// filter widened, a feed's new post), unless the list loads pages at
    /// its start: the page it prepends must not show, or the next would be
    /// asked for at once. An inverted list at its start (item 0 in view at
    /// the bottom) keeps its distance from the end instead, so what
    /// arrives there shows. In its parent's viewport, only while the
    /// list's start is scrolled past (when it shows, the content below it
    /// moves instead).
    fn visible_anchor(&self) -> Option<(u32, f32)> {
        (self.count > 0
            && self.viewport > 0.0
            && self.keeps_visible_rows()
            && (self.offset > 0.0 || (!self.parent && self.loads_at_start)))
            .then(|| {
                let top = self.natural_offset();
                let body = self.blocks().body;
                let row = self.rows.find((top - body).max(0.0) as f64) as u32;
                let index = (row * self.columns).min(self.count - 1);
                (index, self.item_at(index) - top)
            })
    }

    /// The row the viewport starts in, by its first item, and how far
    /// past the row's start the viewport starts, in natural coordinates
    /// (`ref.measureScrollPosition()`); `None` without items or a
    /// viewport. Before the first row (a header, padding) it is item 0, a
    /// negative distance away.
    pub(super) fn scroll_position(&self) -> Option<(u32, f32)> {
        if self.count == 0 || self.viewport <= 0.0 {
            return None;
        }
        let top = self.natural_offset();
        let body = self.blocks().body;
        let row = (self.rows.find((top - body).max(0.0) as f64) as u32).min(self.row_count() - 1);
        let index = (row * self.columns).min(self.count - 1);
        Some((index, top - self.item_at(index)))
    }

    /// Scrolls so item `index` starts `from_top` below the viewport's start
    /// again (a list that is not inverted).
    fn keep_in_place(&mut self, index: u32, from_top: f32) {
        let delta = self.item_at(index) - from_top - self.natural_offset();
        self.compensate_layout_offset(delta);
        self.splice_anchor += delta;
    }

    /// Whether changes before the viewport keep the visible rows in place:
    /// always for lists that are not inverted. Inverted ones keep their
    /// distance from the end (the bottom), unless they load at their start
    /// (`onLoadMoreAtStart`, which opts in) and are laid out and scrolled
    /// away from it: at the start they keep showing item 0 (a chat's newest
    /// message).
    fn keeps_visible_rows(&self) -> bool {
        self.keeps_visible_rows_at(self.natural_offset())
    }

    /// [`ListState::keeps_visible_rows`] with the viewport at `natural`.
    fn keeps_visible_rows_at(&self, natural: f32) -> bool {
        !self.inverted
            || (self.loads_at_start && !self.anchored_end.is_nan() && natural > PIN_SLACK)
    }

    /// Where the viewport starts in natural coordinates while a layout
    /// measures its cells. An inverted list's `content_len` already holds
    /// what this layout changed (a page spliced at its end, rows measured
    /// above the viewport) before `anchor_end` moves the offset to match,
    /// so it counts from the end it last anchored to, plus what the
    /// measurements so far moved the visible rows by.
    fn measuring_natural_offset(&self) -> f32 {
        if self.inverted && !self.anchored_end.is_nan() {
            self.anchored_end - self.offset - self.measured_scroll
        } else {
            self.natural_offset()
        }
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
            let step = if self.inverted { -step } else { step };
            self.lead = next_lead(self.lead, step, self.viewport);
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
        // The app scrolled the list (`initialScrollIndex` too): where it
        // lands may be near the start.
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
    pub(super) fn interaction(&mut self, states: u16) {
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

    /// After measurements: where a pinned list goes for its target, which
    /// moved as estimated sizes became real ones. The pin ends once the
    /// list is there and every item in the viewport is measured (nothing
    /// visible can move it any more).
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
            // The platform moves an animation in flight along with the
            // anchoring scroll.
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
        if self.horizontal && self.mirrored {
            (p.right.0, p.left.0)
        } else if self.horizontal {
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

    /// The offsets after the items past the first `old` were appended or
    /// dropped: only the rows at the end change, so a feed that grows a
    /// row at a time costs O(log n) each, not a rebuild of every row.
    fn resize_rows(&mut self, old: u32) {
        let columns = self.columns;
        let old_rows = old.div_ceil(columns) as usize;
        if self.rows.len() != old_rows {
            self.rebuild_offsets();
            return;
        }
        let rows = self.row_count() as usize;
        let gap = self.main_gap() as f64;
        // The last row kept may have gained or lost items: its size again.
        let kept = old_rows.min(rows);
        self.rows.truncate(kept);
        if kept > 0 {
            let last = kept - 1;
            let now = self.row_size(last as u32) as f64 + gap;
            let was = self.rows.prefix(kept) - self.rows.prefix(last);
            if now != was {
                self.rows.add(last, now - was);
            }
        }
        for r in kept..rows {
            self.rows.push(self.row_size(r as u32) as f64 + gap);
        }
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
        if self.inverted || self.bottom() {
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
            at + self.leading()
        }
    }

    /// The viewport's start in natural coordinates.
    fn natural_offset(&self) -> f32 {
        if self.inverted {
            self.content_len() - self.offset - self.viewport
        } else {
            self.offset - self.leading()
        }
    }

    /// Rests at the end of its content (`alignment="bottom"`).
    fn bottom(&self) -> bool {
        self.alignment == ListAlignment::Bottom && !self.inverted
    }

    /// The free space before content shorter than a bottom-aligned list's
    /// viewport, which keeps its rows at the bottom.
    fn leading(&self) -> f32 {
        if self.bottom() {
            (self.viewport - self.blocks().total).max(0.0)
        } else {
            0.0
        }
    }

    /// Natural position of item `i` (its row's start).
    pub(super) fn item_at(&self, i: u32) -> f32 {
        self.blocks().body + self.rows.prefix(self.row_of(i) as usize) as f32
    }

    /// Size and position of each cell across the main axis: `(offset,
    /// size)` of column `col`. On a terminal's grid of `cell` points
    /// across, every column is as many whole Cells (the share rounded
    /// down, the Cells left over after the last column): rounded each on
    /// its own, they would run into the padding at the end.
    pub(super) fn column(&self, cross: f32, col: u32, cell: Option<f32>) -> (f32, f32) {
        let (start, end) = self.cross_padding();
        let gap = self.cross_gap();
        let n = self.columns as f32;
        let mut width = ((cross - start - end - gap * (n - 1.0)) / n).max(0.0);
        if let Some(cell) = cell.filter(|&c| c > 0.0) {
            width = (width / cell + 1e-3).floor() * cell;
        }
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

    pub(super) fn set_count(&mut self, count: u32) {
        if count == self.count {
            return;
        }
        self.count = count;
        self.source_dirty |= !self.source_geometry.is_empty();
        self.items_changed = true;
        // The rows past the end went: a cell that showed one shows whatever
        // comes there next only once bound again.
        for s in &mut self.slots {
            if s.requested.is_some_and(|r| r >= count) {
                s.requested = None;
                s.rendered = None;
            }
        }
        let old = self.sizes.len() as u32;
        self.sizes.resize(count as usize, f32::NAN);
        self.resize_rows(old);
        if self.load_more_at.is_some_and(|c| c != count) {
            self.load_more_at = None;
        }
    }

    pub(super) fn set_estimated(&mut self, estimated: f32) {
        if estimated > 0.0 && estimated != self.estimated {
            // Rows not measured above the viewport change length: what is
            // visible stays where it is.
            let anchor = self.visible_anchor().filter(|_| !self.inverted);
            self.estimated = estimated;
            self.rebuild_offsets();
            if let Some((index, from_top)) = anchor {
                self.keep_in_place(index, from_top);
            }
        }
    }

    pub(super) fn set_columns(&mut self, columns: u32) {
        let columns = columns.max(1);
        if columns != self.columns {
            // The first visible item stays where it is (a window resized to
            // fit more or fewer columns), not the offset: at the old offset
            // the rows show other items.
            let anchor = self.visible_anchor().filter(|_| !self.inverted).map(
                |(index, from_top)| match self.columns_anchor {
                    Some(kept) if kept < self.count && self.row_of(kept) == self.row_of(index) => {
                        (kept, from_top)
                    }
                    _ => (index, from_top),
                },
            );
            self.columns_anchor = anchor.map(|(index, _)| index);
            self.columns = columns;
            // Cells change width: their sizes are measured again.
            self.sizes.fill(f32::NAN);
            self.cells_cross = f32::NAN;
            self.rebuild_offsets();
            if let Some((index, from_top)) = anchor {
                self.keep_in_place(index, from_top);
            }
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

    /// Whether it shows mirrored (horizontal, right to left): its left and
    /// right content padding keep their sides on screen.
    pub(super) fn set_mirrored(&mut self, mirrored: bool) {
        if mirrored != self.mirrored {
            self.mirrored = mirrored;
            let p = &self.content.padding;
            if self.horizontal && p.left != p.right {
                self.rebuild_offsets();
            }
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
            self.dirty = true;
        }
    }

    pub(super) fn set_alignment(&mut self, alignment: ListAlignment) {
        if self.parent {
            self.ignored |= if alignment == ListAlignment::Top {
                0
            } else {
                ignored::ALIGNMENT
            };
            return;
        }
        if alignment != self.alignment {
            self.alignment = alignment;
            self.anchored_end = f32::NAN;
            self.dirty = true;
        }
    }

    /// Keeps `items` rendered outside the window (none: only the window's).
    pub(super) fn set_kept(&mut self, mut items: Vec<u32>) {
        items.sort_unstable();
        items.dedup();
        if items != self.kept {
            self.kept = items;
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
        let natural = self.measuring_natural_offset();
        let above_viewport = row_start < natural && row_start + before <= natural;
        let keep = above_viewport && self.keeps_visible_rows_at(natural);
        self.sizes[idx] = size;
        let delta = self.row_size(row) - before;
        if delta != 0.0 {
            self.rows.add(row as usize, delta as f64);
        }
        self.dirty = true;
        let scroll = self.before_viewport_changed(keep, delta, natural);
        self.measured_scroll += scroll;
        scroll
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
        let natural = self.measuring_natural_offset();
        let keeps = self.keeps_visible_rows_at(natural);
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
        let scroll = self.before_viewport_changed(keep, delta, natural);
        self.measured_scroll += scroll;
        scroll
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
    /// starts at the end). Bottom-aligned lists start at the end too, and
    /// like other lists with `follow_end` stay at the end
    /// when the end moves away while they are within the threshold of it
    /// (a growing last item, a shrinking viewport); scrolled further up,
    /// they keep what is visible (content grows below it).
    ///
    /// `kept` is how far this commit's measurements moved the offset to keep
    /// the visible rows in place: that move says nothing about where the user
    /// is, so a list at its end is still at its end.
    pub(super) fn anchor_end(&mut self, kept: f32) -> f32 {
        self.measured_scroll = 0.0;
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
            let bottom = self.bottom();
            let threshold = match self.follow_end {
                Some(threshold) => threshold,
                None if bottom => PIN_SLACK,
                None => {
                    self.anchored_end = end;
                    return 0.0;
                }
            };
            if bottom && !self.anchored_end.is_nan() && self.last_row_being_measured() {
                // One scroll, to where the row really ends: scrolling by
                // its estimate first would overshoot and be clamped back.
                self.anchored_end += kept;
                return 0.0;
            }
            let was = std::mem::replace(&mut self.anchored_end, end);
            // A bottom-aligned list opens at its end, without a scroll
            // command to pin and follow while its rows are measured.
            let opening = bottom && was.is_nan();
            let distance = was - (self.offset - kept);
            // Rows above the viewport shrinking while visible ones grow can
            // leave the end where it was and the offset short of it.
            // A negative distance is native overscroll, not a row falling
            // short of the end. Let the platform finish its drag and bounce
            // instead of sending a competing ScrollBy on every report.
            let settle = bottom && (0.0..=PIN_SLACK).contains(&distance);
            if !opening && (was.is_nan() || distance > threshold || (end <= was && !settle)) {
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

    /// The last row is not measured yet but will be: the window reaches it.
    fn last_row_being_measured(&self) -> bool {
        let Some(last) = self.count.checked_sub(1) else {
            return false;
        };
        self.sizes[last as usize].is_nan()
            && self.item_at(last) < self.natural_offset() + self.viewport * (1.0 + OVERSCAN)
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

    /// Whether cell `cell` is a slot's the list freed: bound to no item, it
    /// still holds what it showed last until the list binds it again.
    pub(super) fn frees(&self, cell: u32) -> bool {
        self.slots
            .iter()
            .any(|s| s.cell == cell && s.index.is_none())
    }

    pub(super) fn remove_cell(&mut self, cell: u32) {
        self.source_dirty |= !self.source_geometry.is_empty();
        for slot in &mut self.slots {
            if slot.cell == cell {
                slot.cell = u32::MAX;
                slot.rendered = None;
                slot.requested = None;
                self.dirty = true;
            }
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
        let next = self
            .sticky
            .get(self.sticky.partition_point(|&s| s <= index))
            .filter(|&&s| s < self.count);
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
        self.moved.retain(|&(slot, index)| {
            let s = &self.slots[slot as usize];
            s.index == Some(index) || (s.index.is_none() && s.requested == Some(index))
        });
        // Cells whose item moved: the runtime learns their new index (cheap:
        // the cell shows the same item) before anything else binds.
        binds.append(&mut self.moved);
        if self.count == 0 {
            for slot in 0..self.slots.len() {
                self.unbind(slot as u32);
            }
            return Edges::default();
        }
        let at = self.natural_offset();
        let overscan = self.viewport * OVERSCAN;
        let range = (self.viewport > 0.0)
            .then(|| self.items_in(at - overscan, at + self.viewport + overscan))
            .flatten();
        let sticky = (self.viewport > 0.0)
            .then(|| self.active_sticky())
            .flatten();
        // And the one before it: scrolled back, it shows at once, pushed by
        // the pinned one, before a round of binding could render it.
        let before = sticky.and_then(|s| {
            self.sticky[..self.sticky.partition_point(|&p| p < s)]
                .last()
                .copied()
        });
        let kept = std::mem::take(&mut self.kept);
        let wanted = |i: u32| {
            range.is_some_and(|(f, l)| (f..=l).contains(&i))
                || sticky == Some(i)
                || before == Some(i)
                || source_row == Some(i)
                || kept.contains(&i)
        };

        for slot in 0..self.slots.len() as u32 {
            if let Some(i) = self.slots[slot as usize].index
                && !wanted(i)
            {
                self.unbind(slot);
            }
        }
        // First the items whose own cell is free and still shows them (the
        // window shrank and grew back: a dock showed and went, the window
        // was resized): they take it back as it is, nothing to make again.
        // Then the rest, each in any free cell.
        let bind = |this: &mut Self, i: u32, own: bool| {
            if this.by_index.contains_key(&i) {
                return;
            }
            let slots = &this.slots;
            let shows = |s: &u32| {
                let s = &slots[*s as usize];
                s.rendered == Some(i) && s.requested == Some(i)
            };
            let own_slot = this.free.iter().rposition(shows);
            let slot = match own_slot {
                Some(at) => this.free.remove(at),
                None if own => return,
                None => match this.free.pop() {
                    Some(slot) => slot,
                    None => {
                        this.slots.push(Slot {
                            cell: u32::MAX,
                            index: None,
                            rendered: None,
                            requested: None,
                        });
                        this.slots.len() as u32 - 1
                    }
                },
            };
            this.slots[slot as usize].index = Some(i);
            this.by_index.insert(i, slot);
        };
        let count = self.count;
        let passes: &[bool] = if self.free.is_empty() {
            &[false]
        } else {
            &[true, false]
        };
        for &own in passes {
            if let Some((first, last)) = range {
                for i in first..=last {
                    bind(self, i, own);
                }
            }
            for s in [before, sticky, source_row].into_iter().flatten() {
                bind(self, s, own);
            }
            for &i in kept.iter().filter(|&&i| i < count) {
                bind(self, i, own);
            }
        }
        let (start, end) = self.urgent_span(at);
        let new = binds.len();
        for slot in 0..self.slots.len() {
            let s = self.slots[slot];
            let Some(i) = s.index else { continue };
            if s.requested == Some(i) {
                continue;
            }
            if !self.paced
                || sticky == Some(i)
                || before == Some(i)
                || source_row == Some(i)
                || kept.contains(&i)
                || self.item_overlaps(i, start, end)
            {
                self.slots[slot].requested = Some(i);
                binds.push((slot as u32, i));
            }
        }
        binds[new..].sort_unstable_by_key(|b| b.1);
        self.kept = kept;
        if self.viewport <= 0.0 {
            return Edges::default();
        }

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
    /// the viewport, and ahead of it in the scroll direction
    /// [`URGENT_STEPS`] steps (what the next frames of a fling show, by the
    /// time the rows bound now do). A step longer than the viewport is a
    /// jump: only the viewport.
    fn urgent_span(&self, at: f32) -> (f32, f32) {
        let step = self.lead.abs();
        let ahead = if step <= self.viewport {
            (URGENT_STEPS * step).min(self.viewport * OVERSCAN)
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
        self.slots
            .iter()
            .any(|s| s.index.is_some() && s.index != s.requested)
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
            if s.requested == Some(i) {
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
            let (share, threshold) = match (
                self.viewability.view_area_coverage_threshold,
                self.viewability.item_visible_threshold,
            ) {
                (Some(t), _) => (pixels / self.viewport, t.0),
                (None, Some(t)) => (pixels / size.max(f32::EPSILON), t.0),
                (None, None) => return pixels > 0.0,
            };
            if threshold > 0.0 {
                share >= threshold
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
    use crate::{
        geometry::{Percentage, px},
        props::EdgeInsets,
    };

    fn list(count: u32, estimated: f32, viewport: f32) -> ListState {
        let mut l = ListState::new();
        l.set_estimated(estimated);
        l.set_count(count);
        l.viewport = viewport;
        l
    }

    #[test]
    fn appending_and_dropping_rows_matches_a_rebuild() {
        for columns in [1, 3] {
            let mut l = list(0, 30.0, 400.0);
            l.set_columns(columns);
            l.content.row_gap = px(4.0);
            let check = |l: &mut ListState| {
                let rows = l.rows.clone();
                l.rebuild_offsets();
                assert_eq!(rows.len(), l.rows.len());
                for r in 0..=rows.len() {
                    assert!((rows.prefix(r) - l.rows.prefix(r)).abs() < 1e-6, "row {r}");
                }
            };
            for c in 1..40 {
                l.set_count(c);
                l.measured(c - 1, 20.0 + (c % 5) as f32 * 7.0);
                check(&mut l);
            }
            for _ in 0..10 {
                l.splice(l.count, 0, 2);
                check(&mut l);
            }
            for c in [55, 31, 30, 7, 0, 5] {
                l.set_count(c);
                check(&mut l);
            }
        }
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
    fn bottom_aligned_lists_stay_at_their_end_as_rows_above_are_measured() {
        let mut l = list(100, 50.0, 400.0);
        l.set_alignment(ListAlignment::Bottom);
        l.anchor_end(0.0);
        let end = l.content_len() - 400.0;
        assert_eq!(l.offset, end);
        // A row above the viewport comes out shorter and a visible one taller,
        // by the same amount: the end stays, and the offset must too.
        let kept = l.measured(50, 30.0);
        assert_eq!(kept, -20.0);
        assert_eq!(l.measured(99, 70.0), 0.0);
        l.offset += kept;
        let scroll = l.anchor_end(kept);
        assert_eq!(l.content_len() - 400.0, end);
        assert_eq!(kept + scroll, 0.0);
        assert_eq!(l.offset, end);
        // A kept move while the appended last row is being measured does not
        // lose the end either.
        l.splice(100, 0, 1);
        l.take_splice_anchor();
        let kept = l.measured(51, 30.0);
        l.offset += kept;
        assert_eq!(l.anchor_end(kept), 0.0, "waits for the row's real size");
        l.measured(100, 34.0);
        assert_eq!(l.anchor_end(0.0), 34.0);
        assert_eq!(l.offset, l.content_len() - 400.0);
        // Scrolled up, the same measurements leave it where the user put it.
        let up = l.content_len() - 400.0 - 500.0;
        l.reported(up, 0);
        let kept = l.measured(52, 30.0);
        l.offset += kept;
        assert_eq!(l.anchor_end(kept), 0.0);
        assert_eq!(l.offset, up + kept);
    }

    #[test]
    fn bottom_aligned_lists_rest_at_their_end() {
        let on_screen = |l: &ListState, i: u32| l.to_content(l.item_at(i), 50.0) - l.offset;
        let mut l = list(100, 50.0, 400.0);
        l.set_alignment(ListAlignment::Bottom);
        // Opens at the end, its window there in the same commit.
        assert_eq!(l.anchor_end(0.0), 4600.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert!(binds.iter().any(|&(_, i)| i == 99));
        assert!(!binds.iter().any(|&(_, i)| i == 0));
        // Appending moves no row in the content: one scroll follows.
        let row = l.to_content(l.item_at(90), 50.0);
        l.splice(100, 0, 1);
        assert_eq!(l.take_splice_anchor(), 0.0);
        assert_eq!(l.anchor_end(0.0), 0.0, "waits for the row's real size");
        assert_eq!(l.measured(100, 34.0), 0.0);
        assert_eq!(l.anchor_end(0.0), 34.0);
        assert_eq!(l.to_content(l.item_at(90), 50.0), row);
        // So does the last row growing (a reply streaming in).
        let anchor = l.measured(100, 80.0);
        assert_eq!(anchor + l.anchor_end(0.0), 46.0);
        assert_eq!(l.to_content(l.item_at(90), 50.0), row);
        // Older rows above the viewport leave what shows in place.
        let before = on_screen(&l, 95);
        l.splice(0, 0, 10);
        let scrolled = l.take_splice_anchor();
        assert_eq!(scrolled, 500.0);
        assert_eq!(l.anchor_end(0.0), 0.0);
        assert_eq!(on_screen(&l, 105), before);
        // Scrolled up, growth below leaves it alone; back at the end, it
        // follows again.
        let end = l.content_len() - 400.0;
        l.reported(end - 500.0, 0);
        l.splice(l.count, 0, 1);
        l.take_splice_anchor();
        assert_eq!(l.anchor_end(0.0), 0.0);
        l.measured(l.count - 1, 50.0);
        l.anchor_end(0.0);
        l.reported(l.content_len() - 400.0, 0);
        l.splice(l.count, 0, 1);
        l.take_splice_anchor();
        assert_eq!(l.anchor_end(0.0), 0.0);
        l.measured(l.count - 1, 50.0);
        assert_eq!(l.anchor_end(0.0), 50.0);
        // A page too long for the window to reach its last row follows by
        // the estimate, or the row would never be measured.
        l.splice(l.count, 0, 100);
        assert_eq!(l.anchor_end(0.0), 5000.0);
    }

    #[test]
    fn bottom_aligned_list_preserves_native_bottom_bounce() {
        let mut l = list(20, 50.0, 400.0);
        l.set_alignment(ListAlignment::Bottom);
        l.follow_end = Some(80.0);
        for i in 0..20 {
            l.measured(i, 50.0);
        }
        l.anchor_end(0.0);
        // UIKit reports offsets beyond the end during a drag and spring back.
        // Layout must not send a competing scroll back to the content edge.
        for overshoot in [0.25, 10.0, 30.0, 60.0, 30.0, 10.0, 0.25, 0.0] {
            l.reported(600.0 + overshoot, 0);
            assert_eq!(l.anchor_end(0.0), 0.0, "overshoot {overshoot}");
            assert_eq!(l.offset, 600.0 + overshoot);
        }
    }

    #[test]
    fn bottom_aligned_lists_keep_short_content_at_the_bottom() {
        let mut l = list(2, 50.0, 400.0);
        l.set_alignment(ListAlignment::Bottom);
        assert_eq!(l.anchor_end(0.0), 0.0);
        assert_eq!(l.content_len(), 400.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 300.0);
        assert_eq!(l.to_content(l.item_at(1), 50.0), 350.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.len(), 2);
        // A row more: they rise, with nothing to scroll.
        l.splice(2, 0, 1);
        assert_eq!(l.anchor_end(0.0), 0.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 250.0);
    }

    #[test]
    fn inverted_lists_load_at_their_start_and_keep_the_visible_rows() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.loads_at_start = true;
        l.anchor_end(0.0);
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
        let scrolled = l.take_splice_anchor() + l.anchor_end(0.0);
        assert_eq!(scrolled, 0.0);
        assert_eq!(on_screen(&l, 8), before);
        // So does their measuring.
        let offset = l.offset;
        let anchor = l.measured(0, 80.0);
        l.offset += anchor;
        assert_eq!(anchor + l.anchor_end(anchor), 0.0);
        assert_eq!(l.offset, offset);
        // A forwarded parent correction shares the same inverted integral
        // contract; returning that measured row to its old size cancels too.
        let offset = l.offset;
        let anchor = l.measured(0, 50.0);
        assert_eq!(anchor, 30.0);
        l.anchor_by(anchor);
        assert_eq!(anchor + l.anchor_end(0.0), 0.0);
        assert_eq!(l.offset, offset);
        assert_eq!(on_screen(&l, 8), before);
        // At the start, what arrives there shows (a chat's new message).
        let mut c = list(100, 50.0, 400.0);
        c.set_inverted(true);
        c.loads_at_start = true;
        c.anchor_end(0.0);
        c.splice(0, 0, 1);
        c.take_splice_anchor();
        c.anchor_end(0.0);
        assert_eq!(c.natural_offset(), 0.0);
        // Without `onLoadMoreAtStart`, an inverted list keeps its distance
        // from the end wherever it is, as it always did.
        let mut d = list(100, 50.0, 400.0);
        d.set_inverted(true);
        d.anchor_end(0.0);
        d.reported(5000.0 - 400.0 - 200.0, 0);
        d.splice(0, 0, 4);
        assert_eq!(d.take_splice_anchor(), 0.0);
        d.anchor_end(0.0);
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
    fn a_terminal_s_columns_are_whole_equal_cells() {
        // 9 columns in 1360pt (170 Cells) padded a Cell each side, 2 Cells
        // apart: 16.9 Cells each, rounded down. Each rounded on its own,
        // the last would end in the padding.
        let mut l = list(90, 50.0, 1000.0);
        l.set_columns(9);
        l.content.padding.left = crate::Points(8.0);
        l.content.padding.right = crate::Points(8.0);
        l.content.column_gap = crate::Points(16.0);
        assert_eq!(l.column(1360.0, 1, Some(8.0)), (8.0 + 128.0 + 16.0, 128.0));
        let (x, width) = l.column(1360.0, 8, Some(8.0));
        assert!(x + width <= 1360.0 - 8.0, "the last inside the padding");
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
        assert_eq!(l.column(320.0, 2, None), (320.0 * 2.0 / 3.0, 320.0 / 3.0));
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.len(), 10);
    }

    #[test]
    fn a_mirrored_horizontal_list_keeps_its_left_padding_on_the_left() {
        // Laid out left to right and shown mirrored: the left padding is the
        // end of its main axis, so it shows on the left.
        let mut l = list(3, 50.0, 1000.0);
        l.set_horizontal(true);
        l.set_content(ListContentStyle {
            padding: EdgeInsets {
                left: px(16.0),
                ..EdgeInsets::default()
            },
            ..ListContentStyle::default()
        });
        assert_eq!(l.blocks().body, 16.0);
        l.set_mirrored(true);
        assert_eq!(l.blocks().body, 0.0);
        assert_eq!(l.blocks().total, 3.0 * 50.0 + 16.0);
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
    fn the_scroll_position_is_the_row_at_the_viewports_start_and_the_depth_into_it() {
        assert_eq!(list(0, 50.0, 400.0).scroll_position(), None);
        // A header, then rows 50 points apart with 8-point gaps.
        let mut l = list(100, 50.0, 400.0);
        l.set_content(ListContentStyle {
            row_gap: px(8.0),
            ..ListContentStyle::default()
        });
        l.add_slot_cell(CellSlot::Header, 7);
        l.measured_extra(ExtraKind::Header, 30.0);
        assert_eq!(l.scroll_position(), Some((0, -38.0)));
        l.measured(1, 90.0);
        // In row 2, 5 points in.
        l.offset = 38.0 + 58.0 + 98.0 + 5.0;
        assert_eq!(l.scroll_position(), Some((2, 5.0)));
        // In the gap after row 2: past its size.
        l.offset = 38.0 + 58.0 + 98.0 + 52.0;
        assert_eq!(l.scroll_position(), Some((2, 52.0)));
        // Rows of three: the row's first item.
        l.set_columns(3);
        l.offset = 38.0 + 58.0 + 10.0;
        assert_eq!(l.scroll_position(), Some((3, 10.0)));
        // An inverted list counts from item 0 at the bottom.
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.anchor_end(0.0);
        assert_eq!(l.scroll_position(), Some((0, 0.0)));
        l.offset -= 120.0;
        assert_eq!(l.scroll_position(), Some((2, 20.0)));
    }

    #[test]
    fn lists_follow_the_end_within_the_threshold() {
        let mut l = list(100, 50.0, 400.0);
        l.set_follow_end(Some(10.0));
        assert_eq!(l.anchor_end(0.0), 0.0, "starts where it is");
        // At the end: the last item grows by 30, the list follows.
        l.offset = 5000.0 - 400.0;
        l.measured(99, 80.0);
        assert_eq!(l.anchor_end(0.0), 30.0);
        assert_eq!(l.offset, 5030.0 - 400.0);
        // Scrolled up: it grows below what is visible, which stays.
        l.offset = 1000.0;
        l.measured(99, 120.0);
        assert_eq!(l.anchor_end(0.0), 0.0);
        assert_eq!(l.offset, 1000.0);
        // A child list first corrects overestimated rows above the reader;
        // its remaining rows then make the containing row taller overall.
        let mut child = list(20, 50.0, 400.0);
        child.set_follow_end(Some(10.0));
        child.anchor_end(0.0);
        child.reported(600.0, 0);
        child.anchor_by(-100.0);
        child.measured(19, 250.0);
        assert_eq!(child.anchor_end(0.0), 300.0);
        assert_eq!(child.offset, 800.0);

        // An insertion before a reader well away from the end keeps its
        // source in view; the correction itself is no reason to follow end.
        let mut prepended = list(20, 50.0, 400.0);
        prepended.set_follow_end(Some(10.0));
        prepended.anchor_end(0.0);
        prepended.reported(100.0, 0);
        prepended.splice(0, 0, 12);
        assert_eq!(prepended.offset, 700.0);
        assert_eq!(prepended.take_splice_anchor(), 600.0);
        assert_eq!(prepended.anchor_end(0.0), 0.0);
        assert_eq!(prepended.offset, 700.0);

        // Without the option, nothing follows.
        let mut m = list(100, 50.0, 400.0);
        m.anchor_end(0.0);
        m.offset = 5000.0 - 400.0;
        m.measured(99, 80.0);
        assert_eq!(m.anchor_end(0.0), 0.0);

        // Re-enabling at the end follows an append in the same layout turn,
        // while scrolled up it keeps what is visible.
        m.offset = 5030.0 - 400.0;
        m.splice(100, 0, 1);
        m.set_follow_end(Some(10.0));
        assert_eq!(m.anchor_end(0.0), 50.0);
        assert_eq!(m.offset, 5080.0 - 400.0);

        m.set_follow_end(None);
        m.offset = 1000.0;
        m.anchor_end(0.0);
        m.splice(101, 0, 1);
        m.set_follow_end(Some(10.0));
        assert_eq!(m.anchor_end(0.0), 0.0);
    }

    #[test]
    fn inverted_lists_start_at_the_end_and_keep_their_distance_from_it() {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        // Starts scrolled to the end; item 0 is at the bottom.
        assert_eq!(l.anchor_end(0.0), 5000.0 - 400.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 4950.0);
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        assert_eq!(binds.first().map(|b| b.1), Some(0));
        assert!(binds.iter().all(|b| b.1 <= 16));
        // Older items load (appended): the visible content stays put.
        l.set_count(120);
        assert_eq!(l.anchor_end(0.0), 1000.0);
        assert_eq!(l.offset, 5600.0);
        assert_eq!(l.to_content(l.item_at(0), 50.0), 5950.0);
        // A short list sits at the bottom.
        let mut s = list(2, 50.0, 400.0);
        s.set_inverted(true);
        s.anchor_end(0.0);
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
        l.viewability.item_visible_threshold = Some(Percentage(0.6));
        assert_eq!(l.viewable_items(), Some((1, 3)));
        l.viewability.item_visible_threshold = Some(Percentage(0.5));
        assert_eq!(l.viewable_items(), Some((0, 4)));
    }

    #[test]
    fn viewability_fraction_boundaries_and_viewport_precedence() {
        let mut l = list(100, 100.0, 400.0);
        l.offset = 50.0;
        l.viewability.item_visible_threshold = Some(Percentage(1.0));
        assert_eq!(l.viewable_items(), Some((1, 3)));
        l.viewability.view_area_coverage_threshold = Some(Percentage(0.125));
        assert_eq!(l.viewable_items(), Some((0, 4)));
        l.viewability.view_area_coverage_threshold = Some(Percentage(0.126));
        assert_eq!(l.viewable_items(), Some((1, 3)));
        l.viewability.view_area_coverage_threshold = Some(Percentage(0.0));
        l.offset = 100.0;
        assert_eq!(l.viewable_items(), Some((1, 4)));
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
        // Loading history at the start keeps the visible rows anchored,
        // unlike an ordinary list whose newly prepended row must show.
        l.loads_at_start = true;
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
    fn a_change_of_columns_keeps_the_first_visible_item_in_place() {
        let mut l = list(90, 50.0, 400.0);
        l.set_columns(9);
        // Row 4 (items 36 to 44) at the top.
        l.offset = 200.0;
        assert_eq!(l.item_at(36) - l.offset, 0.0);
        // Five columns: item 36 is in row 7, and still at the top.
        l.set_columns(5);
        assert_eq!(l.item_at(36), 350.0);
        assert_eq!(l.offset, 350.0);
        assert_eq!(l.take_splice_anchor(), 150.0);
        // Back to nine: item 36 again, not the first of the row it was in
        // (35), so resizing back and forth does not drift.
        l.set_columns(9);
        assert_eq!(l.offset, 200.0);
        l.set_columns(7);
        l.set_columns(4);
        l.set_columns(9);
        assert_eq!(l.offset, 200.0);
        // A new estimate for the rows not measured keeps it too.
        l.set_estimated(60.0);
        assert_eq!(l.offset, 240.0);
        l.set_estimated(50.0);
        // Scrolled to another row, its first item is kept.
        l.offset = 100.0;
        l.set_columns(5);
        assert_eq!(l.offset, 50.0 * (18 / 5) as f32);
        // At the top it stays at the top.
        let mut l = list(90, 50.0, 400.0);
        l.set_columns(9);
        l.set_columns(5);
        assert_eq!(l.offset, 0.0);
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

        // The platform reports the scroll: scrolling up by 50, the
        // viewport and four steps above it bind now; the rest above comes
        // before what is below.
        l.reported(2000.0, 0);
        l.update_window(&mut binds, None);
        while l.take_paced(100, &mut binds) > 0 {}
        l.reported(1950.0, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        // 1600..2800 was bound already; 1550..1600 is new and, above
        // 1750, waits.
        assert_eq!(binds, []);
        // A jump binds its viewport only.
        l.reported(5000.0, 0);
        l.update_window(&mut binds, None);
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (100..108).collect::<Vec<_>>());
        // A step up before the overscan bound: the viewport (4975..5375)
        // and four steps ahead (4875..4975) bind now ...
        l.reported(4975.0, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, (97..100).collect::<Vec<_>>());
        // ... the rest above before what is below.
        binds.clear();
        l.take_paced(3, &mut binds);
        assert_eq!(binds.iter().map(|b| b.1).collect::<Vec<_>>(), [96, 95, 94]);
    }

    /// Uneven steps (wheel notches, touchpad events bunched into frames)
    /// bind as far ahead as the fast ones while the scroll goes on the same
    /// way; a turn or a jump starts over from the step itself.
    #[test]
    fn a_fast_step_keeps_the_rows_ahead_binding_through_slow_ones() {
        assert_eq!(next_lead(0.0, 80.0, 400.0), 80.0);
        assert_eq!(next_lead(80.0, 20.0, 400.0), 60.0);
        assert_eq!(next_lead(60.0, 100.0, 400.0), 100.0);
        assert_eq!(next_lead(100.0, -20.0, 400.0), -20.0);
        assert_eq!(next_lead(-20.0, -10.0, 400.0), -15.0);
        // After a jump, the next step binds ahead of the viewport again.
        assert_eq!(next_lead(3000.0, 20.0, 400.0), 20.0);

        let mut l = list(1000, 50.0, 400.0);
        l.paced = true;
        let mut binds = Vec::new();
        l.reported(1000.0, 0);
        l.update_window(&mut binds, None);
        while l.take_paced(100, &mut binds) > 0 {}
        // A step of 100, then one of 10: the span ahead of the viewport is
        // four steps of the 75 kept, 300, not of the 10.
        l.reported(1100.0, 0);
        l.update_window(&mut binds, None);
        l.reported(1110.0, 0);
        binds.clear();
        l.update_window(&mut binds, None);
        assert!(binds.is_empty(), "{binds:?}");
        assert_eq!(l.urgent_span(l.natural_offset()), (1110.0, 1810.0));
    }

    /// A list at its start shows the rows that arrive above its first one,
    /// as a browser does; scrolled past it, the visible rows keep their
    /// place; loading pages at its start, they keep it there too.
    #[test]
    fn a_list_at_its_start_shows_the_rows_inserted_above_the_first() {
        let mut l = list(10, 50.0, 400.0);
        l.splice(0, 0, 3);
        assert_eq!((l.offset, l.take_splice_anchor()), (0.0, 0.0));
        l.offset = 100.0;
        l.splice(0, 0, 2);
        assert_eq!((l.offset, l.take_splice_anchor()), (200.0, 100.0));
        // The page a list loads at its start prepends must not show, or
        // the list would ask for the next at once.
        let mut l = list(10, 50.0, 400.0);
        l.loads_at_start = true;
        l.splice(0, 0, 3);
        assert_eq!((l.offset, l.take_splice_anchor()), (150.0, 150.0));
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
        // Every bound cell learns its new index, at once, and the new row
        // binds with them: the list is at its start, so the row shows. The
        // cells waiting below still wait: nothing of the user's moved.
        let now: Vec<u32> = binds.iter().map(|b| b.1).collect();
        assert_eq!(now, [1, 2, 3, 4, 5, 6, 7, 8, 0], "{binds:?}");
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

    /// Binds the window and confirms what it asked, as the runtime does:
    /// the cells it made, by slot.
    fn bind_all(l: &mut ListState, binds: &mut Vec<(u32, u32)>) {
        binds.clear();
        l.update_window(binds, None);
        for &(slot, index) in binds.iter() {
            if l.slots[slot as usize].cell == u32::MAX {
                l.add_slot_cell(CellSlot::Item(slot), 100 + slot);
            }
            l.rendered(100 + slot, index);
        }
    }

    #[test]
    fn items_take_back_the_free_cell_that_still_shows_them() {
        let mut l = list(100, 50.0, 400.0);
        let mut binds = Vec::new();
        l.offset = 1000.0;
        bind_all(&mut l, &mut binds);
        let cells = |l: &ListState| -> Vec<(u32, u32)> {
            let mut c: Vec<_> = l
                .slots
                .iter()
                .filter_map(|s| s.index.map(|i| (i, s.cell)))
                .collect();
            c.sort_unstable();
            c
        };
        let before = cells(&l);
        // The viewport shrinks (a panel shows below the list), then grows
        // back: the rows at the edges leave the window, then return.
        l.viewport = 200.0;
        bind_all(&mut l, &mut binds);
        assert!(cells(&l).len() < before.len());
        l.viewport = 400.0;
        bind_all(&mut l, &mut binds);
        assert_eq!(cells(&l), before, "each row is back in its own cell");
        assert!(binds.is_empty(), "nothing to bind again: {binds:?}");
        // Scrolled a little, the window gives other rows the free cells.
        l.offset = 1200.0;
        bind_all(&mut l, &mut binds);
        assert!(!binds.is_empty());
    }

    #[test]
    fn free_cells_follow_their_items_through_splices() {
        let mut l = list(100, 50.0, 400.0);
        let mut binds = Vec::new();
        l.offset = 1000.0;
        bind_all(&mut l, &mut binds);
        let cell_of =
            |l: &ListState, i: u32| l.slots.iter().find(|s| s.index == Some(i)).map(|s| s.cell);
        let last = l.slots.iter().filter_map(|s| s.index).max().unwrap();
        let own = cell_of(&l, last).unwrap();
        // The window shrinks: the last row's cell is free, still showing it.
        l.viewport = 200.0;
        bind_all(&mut l, &mut binds);
        assert_eq!(cell_of(&l, last), None);
        // Two rows arrive at the top: the free cell is told its row's new
        // index, and gets it back when the window grows again.
        l.splice(0, 0, 2);
        binds.clear();
        l.update_window(&mut binds, None);
        let slot = l.slots.iter().position(|s| s.cell == own).unwrap() as u32;
        assert!(binds.contains(&(slot, last + 2)), "{binds:?}");
        l.viewport = 400.0;
        bind_all(&mut l, &mut binds);
        assert_eq!(cell_of(&l, last + 2), Some(own));
        assert!(!binds.iter().any(|&(s, _)| s == slot), "{binds:?}");
        // A free cell whose row went is bound again before it shows.
        l.viewport = 200.0;
        bind_all(&mut l, &mut binds);
        assert_eq!(cell_of(&l, last + 2), None);
        l.splice(last + 2, 1, 0);
        let s = l.slots[slot as usize];
        assert_eq!((s.rendered, s.requested), (None, None));
    }

    #[test]
    fn kept_items_stay_rendered_out_of_the_window() {
        let mut l = list(100, 50.0, 400.0);
        l.set_kept(vec![2]);
        l.offset = 3000.0;
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        let bound = |l: &ListState, i: u32| l.slots.iter().any(|s| s.index == Some(i));
        assert!(bound(&l, 2), "{binds:?}");
        assert!(!bound(&l, 3));
        // An item inserted before it moves it along.
        l.splice(0, 0, 1);
        binds.clear();
        l.update_window(&mut binds, None);
        assert!(bound(&l, 3) && !bound(&l, 2), "{binds:?}");
        l.set_kept(Vec::new());
        binds.clear();
        l.update_window(&mut binds, None);
        assert!(!bound(&l, 3));
    }

    /// An inverted chat scrolled into its history (rows 84..92 on screen),
    /// laid out as the core lays it out: measurements, then the splice's
    /// scroll, then `anchor_end`. Returns where row 84 is on screen.
    fn inverted_history(loads_at_start: bool) -> ListState {
        let mut l = list(100, 50.0, 400.0);
        l.set_inverted(true);
        l.loads_at_start = loads_at_start;
        l.anchor_end(0.0);
        l.reported(400.0, 0);
        l
    }

    fn lay_out(l: &mut ListState, measured: &[(u32, f32)]) {
        let mut kept = 0.0;
        for &(i, size) in measured {
            kept += l.measured(i, size);
        }
        l.offset += kept;
        // As the core: the splice already moved the offset.
        let spliced = l.take_splice_anchor();
        l.anchor_end(kept + spliced);
    }

    #[test]
    fn follow_end_list_near_its_start_keeps_a_page_prepended_above() {
        // #1459: a chat that loads older pages at its start, with
        // `maintainVisibleContentPosition`, must not follow the end when a
        // page lands above the reader.
        let mut l = list(12, 66.0, 449.0);
        l.follow_end = Some(100.0);
        lay_out(&mut l, &(0..12).map(|i| (i, 66.0)).collect::<Vec<_>>());
        l.reported(30.0, 0);
        lay_out(&mut l, &[]);
        let before = l.to_content(l.item_at(0), 66.0) - l.offset;
        l.splice(0, 0, 6);
        lay_out(&mut l, &(0..6).map(|i| (i, 66.0)).collect::<Vec<_>>());
        let end = l.content_len() - l.viewport;
        assert!(
            l.offset < end - 100.0,
            "offset {} followed the end {end}",
            l.offset
        );
        assert_eq!(l.to_content(l.item_at(6), 66.0) - l.offset, before);
    }

    fn on_screen(l: &ListState, i: u32) -> f32 {
        l.to_content(l.item_at(i), 50.0) - l.offset
    }

    #[test]
    fn inverted_page_and_row_above_viewport_measured_in_one_layout() {
        // #1238: a page of older rows and a row above the viewport (in the
        // overscan) taking its height in the same layout.
        let mut l = inverted_history(true);
        let before = on_screen(&l, 84);
        l.splice(100, 0, 10);
        lay_out(&mut l, &[(93, 80.0)]);
        assert_eq!(on_screen(&l, 84), before);
    }

    #[test]
    fn inverted_page_and_row_above_viewport_in_separate_layouts() {
        let mut l = inverted_history(true);
        let before = on_screen(&l, 84);
        l.splice(100, 0, 10);
        lay_out(&mut l, &[]);
        assert_eq!(on_screen(&l, 84), before);
        lay_out(&mut l, &[(93, 80.0)]);
        assert_eq!(on_screen(&l, 84), before);
    }

    #[test]
    fn inverted_page_with_rows_below_and_above_viewport_in_one_layout() {
        // A row below the viewport grows too: the visible rows still stay.
        let mut l = inverted_history(true);
        let before = on_screen(&l, 84);
        l.splice(100, 0, 10);
        lay_out(&mut l, &[(80, 80.0), (93, 80.0)]);
        assert_eq!(on_screen(&l, 84), before);
    }

    #[test]
    fn inverted_without_load_more_at_start_keeps_its_distance_from_the_end() {
        let mut l = inverted_history(false);
        let distance = l.content_len() - l.offset;
        l.splice(100, 0, 10);
        lay_out(&mut l, &[(93, 80.0), (80, 80.0)]);
        // Row 80, below the viewport, moves the visible rows up by its
        // growth, as a list that keeps its distance from the end does.
        assert_eq!(l.content_len() - l.offset, distance);
    }

    #[test]
    fn inverted_at_its_start_follows_the_newest_row() {
        let mut l = inverted_history(true);
        l.reported(l.anchored_end, 0);
        l.splice(100, 0, 10);
        lay_out(&mut l, &[(0, 80.0), (8, 80.0)]);
        // Still at the end: item 0 shows at the bottom.
        assert_eq!(l.offset, l.content_len() - l.viewport);
    }

    #[test]
    fn list_not_inverted_keeps_rows_when_rows_above_are_measured() {
        let mut l = list(100, 50.0, 400.0);
        l.reported(1000.0, 0);
        let at = |l: &ListState| l.item_at(25) - l.offset;
        let before = at(&l);
        l.splice(100, 0, 10);
        lay_out(&mut l, &[(15, 80.0), (30, 80.0)]);
        assert_eq!(at(&l), before);
    }
}

#[cfg(test)]
mod perf {
    use std::time::Instant;

    use super::*;

    /// `cargo test -p nsh-core --release perf -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn list_costs() {
        let n = 100_000u32;
        let mut l = ListState::new();
        l.set_estimated(40.0);
        l.viewport = 800.0;
        // Append one row at a time (a log / chat feed).
        let t = Instant::now();
        for c in 1..=n {
            l.set_count(c);
        }
        eprintln!("append 1-by-1 to {n}: {:?}", t.elapsed());
        let t = Instant::now();
        for c in 0..20_000u32 {
            l.splice(l.count, 0, 1);
            let _ = c;
        }
        eprintln!("splice-append 20k: {:?}", t.elapsed());
        let mut binds = Vec::new();
        l.update_window(&mut binds, None);
        for (slot, i) in binds.drain(..) {
            l.rendered(slot, i);
        }
        let t = Instant::now();
        let frames = 20_000;
        for f in 0..frames {
            l.offset = (f as f32) * 7.0;
            l.update_window(&mut binds, None);
            for (slot, i) in binds.drain(..) {
                l.rendered(slot, i);
                l.measured(i, 44.0);
            }
        }
        eprintln!("scroll frame avg: {:?}", t.elapsed() / frames);
    }
}
