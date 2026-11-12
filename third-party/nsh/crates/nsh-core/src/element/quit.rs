//! What runs as the app quits ([`super::desktop::on_app_quit`]; TS:
//! `Application.on("quit", ...)`), as GPUI's `App::on_app_quit`, and what
//! hears the user ask to quit ([`super::desktop::on_quit_request`]; TS:
//! `Application.on("quitRequest", ...)`).
//!
//! The listeners clean up: they cannot keep the app running. When the
//! engine stops (the Quit item, `quit()`, the last window closing, the
//! system ending the app, a host removing its view), the core starts each
//! listener's future ([`crate::Core::start_quit`]) and the engine runs them
//! for [`QUIT_TIMEOUT`] at most ([`crate::Core::quit_pending`]), then
//! stops whatever is left.
//!
//! While a quit request listener is there, the core tells the platform
//! (`DesktopCommand::SetQuitOnRequest(false)`): the user's Quit item and
//! quit key no longer quit, the platform reports them on the root
//! (`WindowEvent::QuitRequest`) and the app quits when it decides to.

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

/// A quit request listener ([`super::desktop::on_quit_request`]).
pub(crate) type QuitRequestListener = Rc<dyn Fn()>;

/// The quit listeners, in the order they were added.
pub(crate) type QuitListeners = Listeners<QuitListener>;

/// The quit request listeners, in the order they were added.
pub(crate) type QuitRequestListeners = Listeners<QuitRequestListener>;

/// Listeners of the app's quitting, in the order they were added.
pub(crate) struct Listeners<L> {
    next: u64,
    list: Vec<(u64, L)>,
}

impl<L> Default for Listeners<L> {
    fn default() -> Self {
        Self {
            next: 0,
            list: Vec::new(),
        }
    }
}

impl<L: Clone> Listeners<L> {
    pub(crate) fn add(&mut self, listener: L) -> u64 {
        self.next += 1;
        self.list.push((self.next, listener));
        self.next
    }

    /// Removes listener `id`; returns it so it is dropped outside the
    /// borrow (it may own what removes others).
    fn remove(&mut self, id: u64) -> Option<L> {
        let i = self.list.iter().position(|(i, _)| *i == id)?;
        Some(self.list.remove(i).1)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// The listeners, oldest first.
    pub(crate) fn all(&self) -> Vec<L> {
        self.list.iter().map(|(_, l)| l.clone()).collect()
    }
}

/// A listener, removed when dropped (with the owner that added it).
pub(crate) struct Subscription<L: Clone> {
    listeners: std::rc::Weak<RefCell<Listeners<L>>>,
    id: u64,
}

/// A quit listener's subscription.
pub(crate) type QuitSubscription = Subscription<QuitListener>;

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
