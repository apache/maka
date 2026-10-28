//! The views' watches of scroll views they did not make (`element::watch`):
//! their targets resolved and changes delivered, once per commit round.

use std::rc::Rc;

use super::Core;
use crate::{
    NodeId, TextEngine,
    element::{ScrollEvent, caught, untracked, watch::ScrollHandler},
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
