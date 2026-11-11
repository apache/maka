//! What runs as the app quits ([`super::desktop::on_app_quit`]; TS:
//! `Application.on("quit", ...)`), as GPUI's `App::on_app_quit`.
//!
//! The listeners clean up: they cannot keep the app running. When the
//! engine stops (the Quit item, `quit()`, the last window closing, the
//! system ending the app, a host removing its view), the core starts each
//! listener's future ([`crate::Core::start_quit`]) and the engine runs them
//! for [`QUIT_TIMEOUT`] at most ([`crate::Core::quit_pending`]), then
//! stops whatever is left.

use std::{
    cell::{Cell, RefCell},
    future::Future,
    pin::Pin,
    rc::Rc,
    time::Duration,
};

/// How long the engine waits for the quit listeners' work, at most: GPUI's
/// `SHUTDOWN_TIMEOUT`. The platform's main thread waits for the engine
/// meanwhile, so it stays short.
pub const QUIT_TIMEOUT: Duration = Duration::from_millis(200);

/// What a quit listener returns: the work it waits for.
pub(crate) type QuitFuture = Pin<Box<dyn Future<Output = ()>>>;

/// A quit listener.
pub(crate) type QuitListener = Rc<dyn Fn() -> QuitFuture>;

/// The quit listeners, in the order they were added.
#[derive(Default)]
pub(crate) struct QuitListeners {
    next: u64,
    list: Vec<(u64, QuitListener)>,
}

impl QuitListeners {
    pub(crate) fn add(&mut self, listener: QuitListener) -> u64 {
        self.next += 1;
        self.list.push((self.next, listener));
        self.next
    }

    /// Removes listener `id`; returns it so it is dropped outside the
    /// borrow (it may own what removes others).
    fn remove(&mut self, id: u64) -> Option<QuitListener> {
        let i = self.list.iter().position(|(i, _)| *i == id)?;
        Some(self.list.remove(i).1)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// The listeners, oldest first.
    pub(crate) fn all(&self) -> Vec<QuitListener> {
        self.list.iter().map(|(_, l)| l.clone()).collect()
    }
}

/// A quit listener, removed when dropped (with the owner that added it).
pub(crate) struct QuitSubscription {
    listeners: std::rc::Weak<RefCell<QuitListeners>>,
    id: u64,
}

impl QuitSubscription {
    pub(crate) fn new(listeners: &Rc<RefCell<QuitListeners>>, id: u64) -> Self {
        Self {
            listeners: Rc::downgrade(listeners),
            id,
        }
    }
}

impl Drop for QuitSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            let removed = listeners.borrow_mut().remove(self.id);
            drop(removed);
        }
    }
}

/// Counts a quit listener's work while it runs: dropped when the work ends
/// or is cancelled.
pub(crate) struct Pending(Rc<Cell<usize>>);

impl Pending {
    pub(crate) fn new(count: &Rc<Cell<usize>>) -> Self {
        count.set(count.get() + 1);
        Self(count.clone())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}
