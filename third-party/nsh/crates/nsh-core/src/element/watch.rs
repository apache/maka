//! Views watching a scroll view they did not make ([`super::watch_scroll`]):
//! a scroll bar of the app's own following a scroll view or a list
//! elsewhere in the tree, as `gpui-base`'s `Scrollbar`
//! follows its scroll handle.
//!
//! The platforms report every scroll view's offset, whoever listens, and the
//! core lays the content out: a scroll watch costs nothing until the core,
//! at the end of a commit round, finds what it watches changed and runs its
//! handler (another round follows, so what the handler changes goes out in
//! the same batch). Targets are resolved again in every commit, so a
//! watch made before its target is mounted (a ref set later in the same
//! render) finds it when it is.

use std::rc::Rc;

use crate::{NodeId, element::events::ScrollEvent};

/// A scroll watch's handler.
pub(crate) type ScrollHandler = Rc<dyn Fn(&ScrollEvent)>;

/// One view's watch of a node.
pub(crate) struct Watch {
    pub(crate) id: u32,
    /// The node watched, resolved again in every commit.
    pub(crate) target: Rc<dyn Fn() -> Option<NodeId>>,
    /// Hears the target's offset, content size or viewport change.
    pub(crate) handler: ScrollHandler,
    /// What it last reported.
    pub(crate) last: Option<ScrollEvent>,
}

/// The views' watches, oldest first.
#[derive(Default)]
pub(crate) struct Watches {
    next: u32,
    pub(crate) list: Vec<Watch>,
}

impl Watches {
    /// Adds a watch; its id.
    pub(crate) fn add(
        &mut self,
        target: Rc<dyn Fn() -> Option<NodeId>>,
        handler: ScrollHandler,
    ) -> u32 {
        let id = self.next;
        self.next += 1;
        self.list.push(Watch {
            id,
            target,
            handler,
            last: None,
        });
        id
    }

    /// Removes watch `id`; returns it so it is dropped outside the borrow
    /// (its handler may own what removes others).
    pub(crate) fn remove(&mut self, id: u32) -> Option<Watch> {
        let i = self.list.iter().position(|w| w.id == id)?;
        Some(self.list.remove(i))
    }
}
