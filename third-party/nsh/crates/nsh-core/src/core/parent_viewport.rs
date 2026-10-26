//! Lists in their parent's viewport (`viewport="parent"`,
//! [`crate::ListViewport::Parent`]): no scroll view of their own, laid out
//! at their full length, virtualized against the scroll view around them.
//!
//! The mode is fixed when the list's native view is made (a change in the
//! batch that makes it still counts). The list then mounts as a plain view
//! that clips its cells, and its Taffy node gets a child of its own, the
//! spacer, as long as its content: the list's padding, border and size
//! limits work as in a browser, and the scroll view around it covers it in
//! its content size.
//!
//! The view it is virtualized against ([`Outer`]) is the nearest scroll
//! view (a `Scroll` or a list of its own) around it on its axis, stopping
//! at root views (screens, modals, overlays, header items, accessories),
//! which are its viewport when there is none. It is found again when views
//! are inserted or moved in a tree with such lists, and the scroll view
//! keeps its lists ([`super::ScrollState`]'s `dependents`), which its
//! scrolls mark for an update. Each update reads where the list starts in
//! the view's content (frames summed up to it, plus the list's border and
//! padding) and feeds [`super::list::ListState`] the view's offset less it.
//!
//! Scrolls the lists ask of their view (anchoring, `scrollToIndex`,
//! `scrollToEnd`) are summed per view and sent once at the end of the
//! commit, counted with the view's other scrolls: platforms report how
//! many they applied, and the view replays the rest over a stale report
//! (as lists do theirs, `ListState::reported`).
//!
//! Lists of their own pay nothing for any of this: every step is reached
//! only through a list in parent mode, and a plain scroll view checks an
//! empty list of dependents.

use super::{
    Core, Key, Kind, NO_KEY, ScrollState, dirty,
    list::{Outer, PendingScroll, StickyRange, ignored, replay},
};
use crate::{
    ListViewport,
    geometry::Points,
    mount::{MountItem, ScrollBehavior, StickyCell, ViewKind},
    ops::{Command, EventKind},
    text::TextEngine,
};

/// The scrolls a scroll view's parent-viewport lists asked of it in the
/// current commit, sent at its end.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(super) struct Asked {
    /// A scroll to this offset (main axis), animated or not.
    pub(super) to: Option<(f32, bool)>,
    /// Then by this much.
    by: f32,
}

/// What a parent-viewport list is virtualized against in this update.
#[derive(Debug, Clone, Copy)]
pub(super) struct OuterInput {
    /// The view.
    pub(super) view: Key,
    /// Where the list's content starts in the view's content.
    pub(super) start: f32,
    /// The view's offset, its pending scrolls included.
    pub(super) offset: f32,
    /// Its viewport's size.
    pub(super) viewport: f32,
    /// The furthest it scrolls.
    pub(super) max: f32,
    /// None of the scrolls issued to it is pending.
    pub(super) settled: bool,
    /// Where the cells start in the list: its border and padding, along
    /// the main and the cross axis.
    pub(super) inset: (f32, f32),
    /// The cross size of the list's content box.
    pub(super) cross: f32,
}

/// The layout style of a list's spacer: `len` along its main axis.
fn spacer_style(horizontal: bool, len: f32) -> taffy::Style {
    let len = taffy::Dimension::length(len.max(0.0));
    taffy::Style {
        size: if horizontal {
            taffy::Size {
                width: len,
                height: taffy::Dimension::auto(),
            }
        } else {
            taffy::Size {
                width: taffy::Dimension::auto(),
                height: len,
            }
        },
        flex_shrink: 0.0,
        ..Default::default()
    }
}

/// The main-axis offset of a plain scroll view: the reported one with the
/// scrolls not applied yet and the ones asked this commit.
fn scroll_offset(scroll: &ScrollState) -> f32 {
    let reported = if scroll.horizontal {
        scroll.offset.0
    } else {
        scroll.offset.1
    };
    let mut at = replay(reported, &scroll.pending);
    if let Some(asked) = &scroll.asked {
        if let Some((to, _)) = asked.to {
            at = to;
        }
        at += asked.by;
    }
    at
}

impl<M: TextEngine> Core<M> {
    /// `viewport` of list `key`: switches its mode while its native view
    /// is not sent yet; later, warns once and keeps it.
    pub(super) fn set_list_viewport(&mut self, key: Key, mode: ListViewport) {
        let node = &self.nodes[key as usize];
        let Some(list) = node.list.as_ref() else {
            return;
        };
        let parent = mode == ListViewport::Parent;
        if list.parent == parent {
            return;
        }
        let id = node.id;
        let create = node.created.then(|| {
            self.mount
                .iter()
                .position(|m| matches!(m, MountItem::Create { id: c, .. } if *c == id))
        });
        if create == Some(None) {
            // Made in an earlier batch.
            let list = self.nodes[key as usize].list.as_mut().expect("list");
            if list.warned & ignored::VIEWPORT == 0 {
                list.warned |= ignored::VIEWPORT;
                log::warn!(
                    target: "js",
                    "List {id}: `viewport` is fixed when the list is made; the change is ignored (render a new list)"
                );
            }
            return;
        }
        let layout = node.layout.expect("list layout");
        let list = self.nodes[key as usize].list.as_mut().expect("list");
        list.set_parent(parent);
        if parent {
            let len = list.content_len();
            let spacer = self.layout.new_leaf(spacer_style(list.horizontal, len));
            self.layout.add_child(layout, spacer);
            list.spacer = Some((spacer, len));
            self.parent_lists.push(key);
            self.outer_moved = true;
        } else {
            if let Some((spacer, _)) = list.spacer.take() {
                self.layout.remove(spacer);
            }
            self.parent_lists.retain(|&k| k != key);
            self.forget_outer(key);
        }
        self.layout.mark_dirty(layout);
        self.needs_layout = true;
        if let Some(Some(at)) = create {
            let kind = if parent {
                ViewKind::View
            } else {
                ViewKind::Scroll
            };
            self.mount[at] = MountItem::Create { id, kind };
            // Parent mode clips its cells; a scroll view gets its config.
            let refreshing = self.nodes[key as usize]
                .scroll
                .as_ref()
                .is_some_and(|s| s.refreshing);
            let flags = match (parent, refreshing) {
                (true, _) => dirty::VIEW,
                (false, false) => dirty::VIEW | dirty::SCROLL,
                (false, true) => dirty::VIEW | dirty::SCROLL | dirty::REFRESHING,
            };
            self.mark(key, flags);
        }
        if parent {
            self.warn_ignored(key);
        }
    }

    /// Gives list `key`'s spacer its content length (and its axis, with
    /// `axis`); a change lays the page out again in this commit.
    pub(super) fn sync_spacer(&mut self, key: Key, axis: bool) {
        let Some(list) = self.nodes[key as usize].list.as_mut() else {
            return;
        };
        let Some((spacer, len)) = list.spacer else {
            return;
        };
        let new = list.content_len();
        if new == len && !axis {
            return;
        }
        list.spacer = Some((spacer, new));
        self.layout
            .set_style(spacer, spacer_style(list.horizontal, new));
        self.needs_layout = true;
        self.extent_changed = true;
    }

    /// Finds the view each parent-viewport list is virtualized against
    /// (after views moved), keeps the scroll views' lists of them, and
    /// orders the lists outer ones first.
    pub(super) fn resolve_outer(&mut self) {
        self.outer_moved = false;
        for i in 0..self.parent_lists.len() {
            let key = self.parent_lists[i];
            let found = self.find_outer(key);
            let list = self.nodes[key as usize].list.as_mut().expect("list");
            let old = std::mem::replace(&mut list.outer, found);
            if old.map(|o| o.view) == found.map(|o| o.view) {
                continue;
            }
            list.dirty = true;
            // Its sticky cells go to the new view with ranges in its offsets.
            let had_sticky = !std::mem::take(&mut list.sent_sticky).is_empty();
            if let Some(old) = old
                && let Some(scroll) = self
                    .nodes
                    .get_mut(old.view as usize)
                    .and_then(|n| n.scroll.as_mut())
            {
                scroll.dependents.retain(|&k| k != key);
                if had_sticky {
                    self.sticky_views.push(old.view);
                }
            }
            if let Some(found) = found
                && found.scrolls
                && let Some(scroll) = self.nodes[found.view as usize].scroll.as_mut()
            {
                scroll.dependents.push(key);
            }
        }
        let nodes = &self.nodes;
        self.parent_lists.sort_by_key(|&k| {
            nodes[k as usize]
                .list
                .as_ref()
                .and_then(|l| l.outer)
                .map_or(0, |o| o.depth)
        });
    }

    /// The nearest scroll view around list `key` on its axis, else the root
    /// view it is in; `None` out of the tree.
    fn find_outer(&self, key: Key) -> Option<Outer> {
        let horizontal = self.nodes[key as usize].list.as_ref()?.horizontal;
        let mut depth = 0;
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            depth += 1;
            let n = &self.nodes[k as usize];
            if k == self.root || n.kind.is_root() {
                return Some(Outer {
                    view: k,
                    scrolls: false,
                    depth,
                });
            }
            let scrolls = match n.kind {
                Kind::Scroll => n
                    .scroll
                    .as_ref()
                    .is_some_and(|s| s.horizontal == horizontal),
                Kind::List => n
                    .list
                    .as_ref()
                    .is_some_and(|l| !l.parent && l.horizontal == horizontal),
                _ => false,
            };
            if scrolls {
                return Some(Outer {
                    view: k,
                    scrolls: true,
                    depth,
                });
            }
            k = n.parent;
        }
        None
    }

    /// Whether moving `key` can move a list in its parent's viewport: it is
    /// one, or a view with children (a text block holds no lists).
    pub(super) fn may_hold_page_list(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        node.list.as_ref().is_some_and(|l| l.parent)
            || (node.kind != Kind::Text && !node.children.is_empty())
    }

    /// List `key` leaves the view it was virtualized against.
    pub(super) fn forget_outer(&mut self, key: Key) {
        let Some(list) = self.nodes[key as usize].list.as_mut() else {
            return;
        };
        let had_sticky = !std::mem::take(&mut list.sent_sticky).is_empty();
        if let Some(outer) = list.outer.take()
            && let Some(scroll) = self
                .nodes
                .get_mut(outer.view as usize)
                .and_then(|n| n.scroll.as_mut())
        {
            scroll.dependents.retain(|&k| k != key);
            if had_sticky {
                self.sticky_views.push(outer.view);
            }
        }
    }

    /// Sends each view in `sticky_views` its sticky cells: its lists' in
    /// its viewport, its own when it is a list, and its sticky views'
    /// ([`super::sticky`]).
    pub(super) fn send_page_sticky(&mut self) {
        let mut views = std::mem::take(&mut self.sticky_views);
        views.sort_unstable();
        views.dedup();
        for view in views {
            let Some(node) = self.nodes.get(view as usize) else {
                continue;
            };
            let Some(scroll) = node.scroll.as_ref() else {
                continue;
            };
            let mut all: Vec<StickyRange> = node
                .list
                .as_ref()
                .map(|l| l.sent_sticky.clone())
                .unwrap_or_default();
            for &d in &scroll.dependents {
                if let Some(list) = self.nodes[d as usize].list.as_ref() {
                    all.extend_from_slice(&list.sent_sticky);
                }
            }
            // And its `position: sticky` views'.
            all.extend_from_slice(&scroll.view_sticky);
            all.sort_by_key(|r| r.cell);
            if all == scroll.page_sticky {
                continue;
            }
            let id = node.id;
            let cells = all
                .iter()
                .map(|r| StickyCell {
                    cell: r.cell,
                    start: Points(r.start),
                    end: Points(r.end),
                    offset: r.offset,
                })
                .collect();
            self.nodes[view as usize]
                .scroll
                .as_mut()
                .expect("scroll")
                .page_sticky = all;
            self.mount.push(MountItem::StickyCells { id, cells });
        }
    }

    /// Node `key`, a view parent-viewport lists were virtualized against,
    /// is released with these lists: they find theirs again.
    pub(super) fn outer_released(&mut self, dependents: &[Key]) {
        for &d in dependents {
            if let Some(list) = self.nodes.get_mut(d as usize).and_then(|n| n.list.as_mut()) {
                list.outer = None;
                list.dirty = true;
            }
        }
        self.outer_moved = true;
    }

    /// Where list `key` is in the view it is virtualized against, and
    /// where that view is; `None` while the list or a view between them is
    /// not laid out.
    pub(super) fn outer_input(&self, key: Key) -> Option<OuterInput> {
        let node = &self.nodes[key as usize];
        let list = node.list.as_ref()?;
        let outer = list.outer?;
        let horizontal = list.horizontal;
        let l = self.rounded_layout(node.layout?);
        let (inset, cross) = if horizontal {
            (
                (l.border.left + l.padding.left, l.border.top + l.padding.top),
                l.size.height - l.border.top - l.border.bottom - l.padding.top - l.padding.bottom,
            )
        } else {
            (
                (l.border.top + l.padding.top, l.border.left + l.padding.left),
                l.size.width - l.border.left - l.border.right - l.padding.left - l.padding.right,
            )
        };
        let main = |x: Points, y: Points| if horizontal { x.0 } else { y.0 };
        let mut start = inset.0;
        let mut k = key;
        while k != outer.view {
            let n = &self.nodes[k as usize];
            let at = main(n.frame.origin.x, n.frame.origin.y);
            if at.is_nan() || n.parent == NO_KEY {
                return None;
            }
            start += at;
            k = n.parent;
        }
        let view = &self.nodes[outer.view as usize];
        let (offset, viewport, max, settled) = if !outer.scrolls {
            let size = if outer.view == self.root {
                self.viewport
            } else {
                let l = self.rounded_layout(view.layout?);
                crate::geometry::size_pt(l.size.width, l.size.height)
            };
            (0.0, main(size.width, size.height), 0.0, true)
        } else {
            let scroll = view.scroll.as_ref()?;
            match view.list.as_ref() {
                Some(own) => (
                    own.offset,
                    own.viewport,
                    (own.content_len() - own.viewport).max(0.0),
                    own.settled() && scroll.asked.is_none(),
                ),
                None => {
                    let viewport = main(view.frame.size.width, view.frame.size.height);
                    if viewport.is_nan() {
                        return None;
                    }
                    let content = scroll.content.map_or(viewport, |c| main(c.width, c.height));
                    (
                        scroll_offset(scroll),
                        viewport,
                        (content - viewport).max(0.0),
                        scroll.pending.is_empty() && scroll.asked.is_none(),
                    )
                }
            }
        };
        Some(OuterInput {
            view: outer.view,
            start,
            offset,
            viewport,
            max,
            settled,
            inset,
            cross: cross.max(0.0),
        })
    }

    /// A parent-viewport list asks its view to scroll to `to` (animated or
    /// not), then by `by`: summed with the other asks of the commit and
    /// sent at its end. The view's lists follow at once.
    pub(super) fn ask_outer(&mut self, view: Key, to: Option<(f32, bool)>, by: f32) {
        let node = &mut self.nodes[view as usize];
        let Some(scroll) = node.scroll.as_mut() else {
            // A root view: nothing scrolls.
            return;
        };
        let asked = match &mut scroll.asked {
            Some(asked) => asked,
            None => {
                self.outer_asked.push(view);
                scroll.asked.insert(Asked::default())
            }
        };
        if let Some(to) = to {
            *asked = Asked {
                to: Some(to),
                by: 0.0,
            };
        }
        asked.by += by;
        if let Some(own) = node.list.as_mut() {
            // A list of its own moves its window as for its own commands.
            if let Some((to, animated)) = to {
                own.pin(None, to, animated, false);
                if !animated {
                    own.jump(to);
                }
            }
            own.anchor_by(by);
        }
        self.dependents_dirty(view);
    }

    /// The lists virtualized against scroll view `view` update in the
    /// next round.
    pub(super) fn dependents_dirty(&mut self, view: Key) {
        let count = self.nodes[view as usize]
            .scroll
            .as_ref()
            .map_or(0, |s| s.dependents.len());
        for i in 0..count {
            let d = self.nodes[view as usize]
                .scroll
                .as_ref()
                .expect("scroll")
                .dependents[i];
            if let Some(list) = self.nodes[d as usize].list.as_mut() {
                list.dirty = true;
            }
        }
    }

    /// Sends the scrolls the lists asked of their views in this commit:
    /// growing content comes first (it is queued already), a scroll back
    /// goes before the view's content shrinks.
    pub(super) fn send_outer_scrolls(&mut self) {
        let batch = self.batches;
        for view in std::mem::take(&mut self.outer_asked) {
            let Some(node) = self.nodes.get_mut(view as usize) else {
                continue;
            };
            let id = node.id;
            let Some(scroll) = node.scroll.as_mut() else {
                continue;
            };
            let Some(asked) = scroll.asked.take() else {
                continue;
            };
            let horizontal = scroll.horizontal;
            let content_item = scroll.content_item.filter(|&(b, _)| b == batch);
            let along = |v: f32| {
                if horizontal {
                    (Points(v), Points::ZERO)
                } else {
                    (Points::ZERO, Points(v))
                }
            };
            if let Some((to, animated)) = asked.to {
                match node.list.as_mut() {
                    Some(own) => own.issue_scroll_to(to),
                    None => issue(scroll, PendingScroll::To(to)),
                }
                let (x, y) = along(to);
                self.mount.push(MountItem::Command {
                    id,
                    command: Command::ScrollTo { x, y, animated },
                });
            }
            if asked.by != 0.0 {
                let node = &mut self.nodes[view as usize];
                match node.list.as_mut() {
                    Some(own) => own.issue_scroll_by(asked.by),
                    None => issue(
                        node.scroll.as_mut().expect("scroll"),
                        PendingScroll::By(asked.by),
                    ),
                }
                let (dx, dy) = along(asked.by);
                let item = MountItem::ScrollBy { id, dx, dy };
                let before =
                    (asked.by < 0.0)
                        .then_some(content_item)
                        .flatten()
                        .and_then(|(_, i)| {
                            let at = self.mount.get(i..)?.iter().position(
                                |m| matches!(m, MountItem::ScrollContent { id: c, .. } if *c == id),
                            )?;
                            Some(i + at)
                        });
                match before {
                    Some(at) => self.mount.insert(at, item),
                    None => self.mount.push(item),
                }
            }
        }
    }

    /// A plain scroll view `key` was sent a scroll of the core's (each one
    /// counts: platforms report how many they applied); its lists replay
    /// it over reports that predate it.
    pub(super) fn scroll_issued(&mut self, key: Key, scroll: PendingScroll) {
        let Some(state) = self.nodes[key as usize].scroll.as_mut() else {
            return;
        };
        issue(state, scroll);
        if !state.dependents.is_empty() {
            self.dependents_dirty(key);
        }
    }

    /// Warns once of each prop list `key` ignores in its parent's
    /// viewport: they are the scroll view's around it, or need a scroll
    /// view of the list's own.
    pub(super) fn warn_ignored(&mut self, key: Key) {
        let node = &self.nodes[key as usize];
        let Some(list) = node.list.as_ref().filter(|l| l.parent) else {
            return;
        };
        let mut bits = list.ignored;
        if [
            EventKind::Scroll,
            EventKind::ScrollEnd,
            EventKind::ScrollDragStart,
            EventKind::ScrollDragEnd,
            EventKind::MomentumStart,
            EventKind::MomentumEnd,
        ]
        .into_iter()
        .any(|e| node.events.contains(e))
        {
            bits |= ignored::ON_SCROLL;
        }
        if node.events.contains(EventKind::Refresh) {
            bits |= ignored::REFRESH;
        }
        if let Some(scroll) = node.scroll.as_ref() {
            if scroll.scroll_value.is_some() {
                bits |= ignored::SCROLL_VALUE;
            }
            if scroll.refreshing
                || scroll.pull_value.is_some()
                || scroll.behavior.refresh_indicator.is_some()
            {
                bits |= ignored::REFRESH;
            }
            // The app's refresh indicator counts as refresh above.
            let behavior = ScrollBehavior {
                refresh_indicator: None,
                ..scroll.behavior.clone()
            };
            if behavior != ScrollBehavior::default()
                || scroll.keyboard_dismiss != crate::ops::KeyboardDismissMode::None
            {
                bits |= ignored::BEHAVIOR;
            }
            if !scroll.scrollbar_visible {
                bits |= ignored::SCROLLBAR;
            }
        }
        let new = bits & !list.warned;
        if new == 0 {
            return;
        }
        let id = node.id;
        self.nodes[key as usize].list.as_mut().expect("list").warned |= new;
        for (bit, what, why) in IGNORED {
            if new & bit != 0 {
                log::warn!(target: "js", "List {id} (viewport=\"parent\") ignores {what}: {why}");
            }
        }
    }
}

/// Counts a scroll sent to a plain scroll view, kept for its lists'
/// replay while it has any.
fn issue(scroll: &mut ScrollState, pending: PendingScroll) {
    scroll.issued = scroll.issued.wrapping_add(1);
    if !scroll.dependents.is_empty() {
        scroll.pending.push((scroll.issued, pending));
    }
}

const AROUND: &str = "the scroll view around the list scrolls it";
const OWN: &str = "it needs a scroll view of its own (viewport=\"own\")";

/// What each [`ignored`] bit stands for, and why.
const IGNORED: [(u16, &str, &str); 7] = [
    (ignored::INVERTED, "`inverted`", OWN),
    (ignored::FOLLOW_END, "`maintainVisibleContentPosition`", OWN),
    (
        ignored::ON_SCROLL,
        "`onScroll` and the other scroll events",
        AROUND,
    ),
    (ignored::SCROLL_VALUE, "`scrollValue`", AROUND),
    (
        ignored::REFRESH,
        "`refreshing`, `onRefresh`, `pullValue` and `refreshIndicator`",
        AROUND,
    ),
    (
        ignored::BEHAVIOR,
        "paging, snapping, `contentInset`, `contentOffset`, `bounces`, `scrollable` and `keyboardDismissMode`",
        AROUND,
    ),
    (ignored::SCROLLBAR, "`scrollbar`", AROUND),
];
