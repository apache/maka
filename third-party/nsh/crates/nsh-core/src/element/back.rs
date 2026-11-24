//! The Android back button for views ([`super::on_back_press`]; TS:
//! `BackHandler.on("press", ...)`) and the back gesture's progress
//! ([`super::on_back_progress`]; TS: `BackHandler.on("progress", ...)`).
//!
//! The newest modal takes the button first, natively. Without one, the
//! root's `BackPress` event comes when the app listens: the views'
//! listeners run newest first until one returns true; then JS's, if it
//! listens. When no one handles it, the core sends [`crate::Command::Back`]:
//! the innermost stack pops (or asks, with `popOnBack` false), else the app
//! exits. The root listens while a listener of either side exists, so with
//! none the platform goes back on the spot, as `Command::Back` would.
//!
//! The root's `BackProgress` event comes while the app listens to it, for
//! gestures that no modal takes: every listener hears every step, the
//! views' first, then JS's. While it listens, the stacks leave the gesture
//! to the app and no longer follow it themselves.

use std::{cell::RefCell, rc::Rc};

use crate::BackProgressEvent;

/// A back listener: whether it handled the press.
pub(crate) type BackListener = Rc<dyn Fn() -> bool>;

/// A listener of the back gesture's steps.
pub(crate) type BackProgressListener = Rc<dyn Fn(&BackProgressEvent)>;

/// The views' back listeners, in the order they were added.
pub(crate) type BackListeners = Listeners<BackListener>;

/// The views' listeners of the back gesture's steps, in the order they
/// were added.
pub(crate) type BackProgressListeners = Listeners<BackProgressListener>;

/// Listeners in the order they were added.
pub(crate) struct Listeners<L> {
    next: u64,
    pub(crate) list: Vec<(u64, L)>,
    /// The list went from empty to not or back since the core last looked.
    pub(crate) changed: bool,
}

impl<L> Default for Listeners<L> {
    fn default() -> Self {
        Self {
            next: 0,
            list: Vec::new(),
            changed: false,
        }
    }
}

impl<L: Clone> Listeners<L> {
    pub(crate) fn add(&mut self, listener: L) -> u64 {
        self.next += 1;
        self.changed |= self.list.is_empty();
        self.list.push((self.next, listener));
        self.next
    }

    /// Removes listener `id`; returns it so it is dropped outside the
    /// borrow (it may own what removes others).
    pub(crate) fn remove(&mut self, id: u64) -> Option<L> {
        let i = self.list.iter().position(|(i, _)| *i == id)?;
        let (_, listener) = self.list.remove(i);
        self.changed |= self.list.is_empty();
        Some(listener)
    }

    /// The listeners newest first.
    pub(crate) fn newest_first(&self) -> Vec<L> {
        self.list.iter().rev().map(|(_, l)| l.clone()).collect()
    }
}

/// A listener, removed when dropped (with the owner that added it).
pub(crate) struct Subscription<L: Clone> {
    listeners: std::rc::Weak<RefCell<Listeners<L>>>,
    id: u64,
}

impl<L: Clone> Subscription<L> {
    pub(crate) fn new(listeners: &Rc<RefCell<Listeners<L>>>, id: u64) -> Self {
        Self {
            listeners: Rc::downgrade(listeners),
            id,
        }
    }
}

impl<L: Clone> Drop for Subscription<L> {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            let removed = listeners.borrow_mut().remove(self.id);
            drop(removed);
        }
    }
}
