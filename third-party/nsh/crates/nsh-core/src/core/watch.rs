//! The views' watches of scroll views they did not make (`element::watch`):
//! their targets resolved and changes delivered, once per commit round; and
//! their watches of the order of elements, put in tree order in the round
//! they were invalidated in.

use std::rc::Rc;

use super::{Core, Key, NO_KEY};
use crate::{
    NodeId, TextEngine,
    element::{
        ElementRef, ScrollEvent, caught, untracked,
        watch::{OrderElements, OrderHandler, ScrollHandler},
    },
};

/// A watch as one round sees it, taken out of the executor's list so its
/// target and handler run with no borrow held.
struct Seen {
    id: u32,
    target: Rc<dyn Fn() -> Option<NodeId>>,
    handler: ScrollHandler,
    last: Option<ScrollEvent>,
}

impl<M: TextEngine> Core<M> {
    /// Resolves the watches' targets and runs those whose target moved, was
    /// laid out again or was found; whether a handler ran (another round
    /// sends what it changed).
    pub(super) fn sync_watches(&mut self) -> bool {
        let ordered = self.sync_orders();
        self.sync_scroll_watches() || ordered
    }

    /// Puts the elements of the order watches invalidated since in tree
    /// order and tells their handlers; whether one ran.
    fn sync_orders(&mut self) -> bool {
        let watches = self.components.executor.watches.clone();
        // A move may reorder any watch's elements (an app's keyed list of
        // them): every watch looks again.
        if std::mem::take(&mut self.components.moved) {
            for order in &watches.borrow().orders {
                order.dirty.set(true);
            }
        }
        if !watches.borrow().orders_dirty() {
            return false;
        }
        let due: Vec<(OrderElements, OrderHandler)> = watches
            .borrow()
            .orders
            .iter()
            .filter(|o| o.dirty.replace(false))
            .map(|o| (o.elements.clone(), o.handler.clone()))
            .collect();
        let _entered = self.components.runtime.enter();
        let mut ran = false;
        for (elements, handler) in due {
            let nodes: Vec<Option<NodeId>> = untracked(|| (elements)())
                .iter()
                .map(ElementRef::node)
                .collect();
            let paths: Vec<Option<Vec<u32>>> = nodes
                .iter()
                .map(|node| node.and_then(|id| self.tree_path(id)))
                .collect();
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
