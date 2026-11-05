//! The views' watches of scroll views they did not make (`element::watch`):
//! their targets resolved and changes delivered, once per commit round; and
//! their watches of the order of elements, put in tree order in the round
//! they were invalidated in, or in which a node moved inside the subtree
//! their elements share.

use std::{cell::Cell, rc::Rc};

use rustc_hash::FxHashSet;

use super::{Core, Key, NO_KEY};
use crate::{
    NodeId, TextEngine,
    element::{
        ElementRef, ScrollEvent, caught, untracked,
        watch::{FocusHandler, Order, OrderElements, OrderHandler, ScrollHandler},
    },
};

/// An order watch due to be looked at, taken out of the executor's list so
/// its elements and handler run with no borrow held.
struct Due {
    elements: OrderElements,
    handler: OrderHandler,
    container: Rc<Cell<Option<NodeId>>>,
}

/// A watch as one round sees it, taken out of the executor's list so its
/// target and handler run with no borrow held.
struct Seen {
    id: u32,
    target: Rc<dyn Fn() -> Option<NodeId>>,
    handler: ScrollHandler,
    last: Option<ScrollEvent>,
}

/// A focus watch as one round sees it, taken out of the executor's list.
struct SeenFocus {
    id: u32,
    target: Rc<dyn Fn() -> Option<NodeId>>,
    handler: FocusHandler,
    last: Option<bool>,
}

impl<M: TextEngine> Core<M> {
    /// Resolves the watches' targets and runs those whose target moved, was
    /// laid out again or was found; whether a handler ran (another round
    /// sends what it changed).
    pub(super) fn sync_watches(&mut self) -> bool {
        let ordered = self.sync_orders();
        let focused = self.sync_focus_watches();
        self.sync_scroll_watches() || ordered || focused
    }

    /// Tells the focus watches whose element the focus came into or left
    /// since they last looked; whether a handler ran. Nothing to do unless
    /// the focus moved or a watch has not found its element yet.
    fn sync_focus_watches(&mut self) -> bool {
        let watches = self.components.executor.watches.clone();
        let moved = std::mem::take(&mut self.focus_within_changed);
        if watches.borrow().focus.is_empty() || !moved && !watches.borrow().focus_unresolved() {
            return false;
        }
        let seen: Vec<SeenFocus> = watches
            .borrow()
            .focus
            .iter()
            .filter(|w| moved || w.last.is_none())
            .map(|w| SeenFocus {
                id: w.id,
                target: w.target.clone(),
                handler: w.handler.clone(),
                last: w.last,
            })
            .collect();
        let _entered = self.components.runtime.enter();
        let mut ran = false;
        for w in seen {
            let Some(node) = untracked(|| (w.target)()) else {
                continue;
            };
            let now = self.has_focus_within(node);
            if let Some(kept) = watches.borrow_mut().focus.iter_mut().find(|k| k.id == w.id) {
                kept.last = Some(now);
            }
            // Found just now: what holds is where it starts, not a move.
            if w.last.is_none_or(|last| last == now) {
                continue;
            }
            if let Err(message) = caught(|| (w.handler)(now)) {
                log::error!(target: "js", "a focus watch failed: {message}");
            }
            self.apply_actions();
            ran = true;
        }
        ran
    }

    /// Notes that a node moved from parent `from` to parent `to`, for the
    /// order watches to look at at the end of the round.
    pub(super) fn note_move(&mut self, from: Key, to: Key) {
        let moved = &mut self.components.moved;
        for key in [from, to] {
            let id = self.nodes[key as usize].id;
            // A keyed reorder moves its rows within one parent: noted once.
            if moved.last() != Some(&id) {
                moved.push(id);
            }
        }
    }

    /// Puts the elements of the order watches invalidated since in tree
    /// order and tells their handlers; whether one ran.
    fn sync_orders(&mut self) -> bool {
        let watches = self.components.executor.watches.clone();
        if !self.components.moved.is_empty() {
            let mut moved = std::mem::take(&mut self.components.moved);
            if !watches.borrow().orders.is_empty() {
                self.dirty_moved_orders(&watches.borrow().orders, &moved);
            }
            // The buffer is kept for the next round's moves.
            moved.clear();
            self.components.moved = moved;
        }
        if !watches.borrow().orders_dirty() {
            return false;
        }
        let due: Vec<Due> = watches
            .borrow()
            .orders
            .iter()
            .filter(|o| o.dirty.replace(false))
            .map(|o| Due {
                elements: o.elements.clone(),
                handler: o.handler.clone(),
                container: o.container.clone(),
            })
            .collect();
        let _entered = self.components.runtime.enter();
        let mut ran = false;
        for Due {
            elements,
            handler,
            container,
        } in due
        {
            let nodes: Vec<Option<NodeId>> = untracked(|| (elements)())
                .iter()
                .map(ElementRef::node)
                .collect();
            let paths: Vec<Option<Vec<u32>>> = nodes
                .iter()
                .map(|node| node.and_then(|id| self.tree_path(id)))
                .collect();
            container.set(self.common_ancestor(&paths));
            let mut order: Vec<usize> = (0..nodes.len()).collect();
            // Stable: what is not in the tree keeps its place among itself.
            order.sort_by(|&a, &b| match (&paths[a], &paths[b]) {
                (Some(path), Some(other)) => path.cmp(other),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
            // In order already (what the watch keeps sorted stays so):
            // nothing to tell, no round to run.
            if order.iter().enumerate().all(|(at, &i)| at == i) {
                continue;
            }
            if let Err(message) = caught(|| handler(&order)) {
                log::error!(target: "js", "an order watch failed: {message}");
            }
            self.apply_actions();
            ran = true;
        }
        ran
    }

    /// Marks the order watches a move may have reordered: those whose
    /// elements' common ancestor is one of the parents nodes moved out of
    /// or into, or an ancestor of one. The order of nodes changes only
    /// among the children of a parent a node moved in or out of, so
    /// elements below none of those parents keep theirs.
    fn dirty_moved_orders(&self, orders: &[Order], moved: &[NodeId]) {
        let mut above: FxHashSet<Key> = FxHashSet::default();
        // A parent gone since (released in the same round) leaves its
        // ancestors unknown: every watch looks again.
        let mut all = false;
        for &id in moved {
            let Ok(mut key) = self.key(id) else {
                all = true;
                break;
            };
            // What is in the set already has its ancestors in it too.
            while key != NO_KEY && above.insert(key) {
                key = self.nodes[key as usize].parent;
            }
        }
        for order in orders {
            if order.dirty.get() {
                continue;
            }
            let reached = all
                || order
                    .container
                    .get()
                    .and_then(|id| self.key(id).ok())
                    .is_none_or(|key| above.contains(&key));
            if reached {
                order.dirty.set(true);
            }
        }
    }

    /// The node the paths ([`Self::tree_path`]) of elements in the tree all
    /// go through last: their nearest common ancestor (an element itself,
    /// when it is the only one); `None` when none is in the tree.
    fn common_ancestor(&self, paths: &[Option<Vec<u32>>]) -> Option<NodeId> {
        let mut present = paths.iter().flatten();
        let first = present.next()?;
        let shared = present.fold(first.len(), |len, path| {
            first[..len]
                .iter()
                .zip(path)
                .take_while(|(a, b)| a == b)
                .count()
        });
        let mut key = self.root;
        for &at in &first[..shared] {
            key = *self.nodes[key as usize].children.get(at as usize)?;
        }
        Some(self.nodes[key as usize].id)
    }

    /// The indices of node `id` and its ancestors among their parents'
    /// children, from the root's down: what orders nodes as the tree does.
    /// `None` when it is not in the root's tree.
    fn tree_path(&self, id: NodeId) -> Option<Vec<u32>> {
        let mut key: Key = self.key(id).ok()?;
        let mut path = Vec::new();
        while key != self.root {
            let parent = self.nodes[key as usize].parent;
            if parent == NO_KEY {
                return None;
            }
            let at = self.nodes[parent as usize]
                .children
                .iter()
                .position(|&c| c == key)?;
            path.push(at as u32);
            key = parent;
        }
        path.reverse();
        Some(path)
    }

    /// Resolves the scroll watches' targets and runs those whose target
    /// moved, was laid out again or was found; whether a handler ran.
    fn sync_scroll_watches(&mut self) -> bool {
        let watches = self.components.executor.watches.clone();
        let seen: Vec<Seen> = watches
            .borrow()
            .list
            .iter()
            .map(|w| Seen {
                id: w.id,
                target: w.target.clone(),
                handler: w.handler.clone(),
                last: w.last,
            })
            .collect();
        if seen.is_empty() {
            return false;
        }
        let _entered = self.components.runtime.enter();
        let mut ran = false;
        for w in seen {
            let node = untracked(|| (w.target)()).unwrap_or(0);
            let now = self.scroll_report(node);
            if now == w.last {
                continue;
            }
            Self::note_watch(&watches, w.id, now);
            if let Some(event) = now {
                if let Err(message) = caught(|| (w.handler)(&event)) {
                    log::error!(target: "js", "a scroll watch failed: {message}");
                }
                self.apply_actions();
                ran = true;
            }
        }
        ran
    }

    /// Records what watch `id` reported, if it is still there.
    fn note_watch(
        watches: &std::cell::RefCell<crate::element::watch::Watches>,
        id: u32,
        last: Option<ScrollEvent>,
    ) {
        if let Some(w) = watches.borrow_mut().list.iter_mut().find(|w| w.id == id) {
            w.last = last;
        }
    }

    /// What `on_scroll` would report of scroll view (or list) `id` now, or
    /// of a multiline input whose platform reports its scrolling; none for
    /// a node that is not one, or not made yet.
    pub(super) fn scroll_report(&self, id: NodeId) -> Option<ScrollEvent> {
        let node = &self.nodes[self.key(id).ok()? as usize];
        if !node.created {
            return None;
        }
        if let Some(input) = node.input.as_ref() {
            let s = input.scroll?;
            return Some(ScrollEvent {
                offset: s.offset,
                content_size: s.content,
                size: s.viewport,
                zoom_scale: 1.0,
            });
        }
        let scroll = node.scroll.as_ref()?;
        let frame = node.frame.size;
        let content = scroll.content.unwrap_or(frame);
        let (x, y) = scroll.offset;
        Some(ScrollEvent {
            offset: crate::geometry::point(crate::geometry::px(x), crate::geometry::px(y)),
            content_size: content * scroll.zoom,
            size: frame,
            zoom_scale: scroll.zoom,
        })
    }
}
