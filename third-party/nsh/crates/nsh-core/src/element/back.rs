//! The Android back button for views ([`super::on_back_press`]; TS:
//! `BackHandler.onBackPress(...)`).
//!
//! The newest modal takes the button first, natively. Without one, the
//! root's `BackPress` event comes when the app listens: the views'
//! listeners run newest first until one returns true; then JS's, if it
//! listens. When no one handles it, the core sends [`crate::Command::Back`]:
//! the innermost stack pops (or asks, with `popOnBack` false), else the app
//! exits. The root listens while a listener of either side exists, so with
//! none the platform goes back on the spot, as `Command::Back` would.

use std::{cell::RefCell, rc::Rc};

/// A back listener: whether it handled the press.
pub(crate) type BackListener = Rc<dyn Fn() -> bool>;

/// The views' back listeners, in the order they were added.
#[derive(Default)]
pub(crate) struct BackListeners {
    next: u64,
    pub(crate) list: Vec<(u64, BackListener)>,
    /// The list went from empty to not or back since the core last looked.
    pub(crate) changed: bool,
}

impl BackListeners {
    pub(crate) fn add(&mut self, listener: BackListener) -> u64 {
        self.next += 1;
        self.changed |= self.list.is_empty();
        self.list.push((self.next, listener));
        self.next
    }

    /// Removes listener `id`; returns it so it is dropped outside the
    /// borrow (it may own what removes others).
    pub(crate) fn remove(&mut self, id: u64) -> Option<BackListener> {
        let i = self.list.iter().position(|(i, _)| *i == id)?;
        let (_, listener) = self.list.remove(i);
        self.changed |= self.list.is_empty();
        Some(listener)
    }

    /// The listeners newest first.
    pub(crate) fn newest_first(&self) -> Vec<BackListener> {
        self.list.iter().rev().map(|(_, l)| l.clone()).collect()
    }
}

/// A listener of the back button, removed when dropped (with the owner that
/// added it).
pub(crate) struct BackSubscription {
    listeners: std::rc::Weak<RefCell<BackListeners>>,
    id: u64,
}

impl BackSubscription {
    pub(crate) fn new(listeners: &Rc<RefCell<BackListeners>>, id: u64) -> Self {
        Self {
            listeners: Rc::downgrade(listeners),
            id,
        }
    }
}

impl Drop for BackSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            let removed = listeners.borrow_mut().remove(self.id);
            drop(removed);
        }
    }
}
