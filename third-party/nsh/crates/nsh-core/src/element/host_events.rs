//! The Rust listeners of the host's events ([`super::on_host_event`]; TS:
//! `host.on`).
//!
//! The core hands each event to the listeners of its name that are there
//! when it comes, oldest first (`Core::host_event`): the embedding app's
//! (the engine's channel) and the web page's (the root's `Host` event of
//! `type: "event"`, which JS's listeners hear too). An event no listener
//! of its name hears is kept until one is added, as JS keeps the embedding
//! app's (`Core::release_host_events`).

use std::{cell::RefCell, rc::Rc};

use crate::JsonValue;

/// A listener of the host's events of one name.
pub(crate) type HostListener = Rc<dyn Fn(&JsonValue)>;

/// The views' listeners of the host's events, in the order they were added.
#[derive(Default)]
pub(crate) struct HostListeners {
    next: u64,
    list: Vec<(u64, String, HostListener)>,
    /// A listener was added since the core last looked for the events kept
    /// for it (`Core::release_host_events`).
    pub(crate) added: bool,
}

impl HostListeners {
    pub(crate) fn add(&mut self, event: String, listener: HostListener) -> u64 {
        self.next += 1;
        self.list.push((self.next, event, listener));
        self.added = true;
        self.next
    }

    /// Whether a listener of `event` is there.
    pub(crate) fn listens(&self, event: &str) -> bool {
        self.list.iter().any(|(_, e, _)| e == event)
    }

    /// The names listened to, each once, in the order their first
    /// listeners were added.
    pub(crate) fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for (_, event, _) in &self.list {
            if !names.contains(event) {
                names.push(event.clone());
            }
        }
        names
    }

    /// Removes listener `id`; returns it so it is dropped outside the
    /// borrow (it may own what removes others).
    pub(crate) fn remove(&mut self, id: u64) -> Option<HostListener> {
        let i = self.list.iter().position(|(i, ..)| *i == id)?;
        Some(self.list.remove(i).2)
    }

    /// The listeners of `event`, oldest first.
    pub(crate) fn of(&self, event: &str) -> Vec<HostListener> {
        self.list
            .iter()
            .filter(|(_, e, _)| e == event)
            .map(|(.., l)| l.clone())
            .collect()
    }
}

/// A listener of the host's events, removed when dropped (with the owner
/// that added it).
pub(crate) struct HostSubscription {
    listeners: std::rc::Weak<RefCell<HostListeners>>,
    id: u64,
}

impl HostSubscription {
    pub(crate) fn new(listeners: &Rc<RefCell<HostListeners>>, id: u64) -> Self {
        Self {
            listeners: Rc::downgrade(listeners),
            id,
        }
    }
}

impl Drop for HostSubscription {
    fn drop(&mut self) {
        if let Some(listeners) = self.listeners.upgrade() {
            let removed = listeners.borrow_mut().remove(self.id);
            drop(removed);
        }
    }
}
