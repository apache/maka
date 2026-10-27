//! Keyboard shortcuts of views ([`super::on_key`]; TS: `keymap.bind`).
//!
//! The platform matches keys against the surface's one table (the root's
//! `Prop::Keymap`) and reports a match with the root's `KeyCommand` event.
//! The core makes that table of JS's bindings and the views', and runs a
//! view's handler itself; the others go to JS. Views' binding ids start at
//! [`FIRST_ID`], above any JS gives, so the two never meet.

use std::rc::Rc;

use crate::keymap::KeyBinding;

/// A view's shortcut handler: it gets the keystroke as written.
pub(crate) type KeyHandler = Rc<dyn Fn(&str)>;

/// The first id of a view's binding.
pub(crate) const FIRST_ID: u32 = 1 << 31;

/// A view's binding: what the platform matches, the keystroke as written
/// (what the handler gets) and the handler.
pub(crate) struct ViewKey {
    pub(crate) binding: KeyBinding,
    pub(crate) text: Rc<str>,
    pub(crate) handler: KeyHandler,
}

/// The views' bindings, oldest first (the newest that may fire wins).
#[derive(Default)]
pub(crate) struct ViewKeys {
    next: u32,
    pub(crate) list: Vec<ViewKey>,
    /// The list changed since the core last made the table.
    pub(crate) changed: bool,
}

impl ViewKeys {
    /// Adds a binding; its id.
    pub(crate) fn add(
        &mut self,
        make: impl FnOnce(u32) -> KeyBinding,
        text: Rc<str>,
        handler: KeyHandler,
    ) -> u32 {
        let id = FIRST_ID + self.next;
        self.next += 1;
        self.list.push(ViewKey {
            binding: make(id),
            text,
            handler,
        });
        self.changed = true;
        id
    }

    /// Removes binding `id`; returns it so it is dropped outside the borrow
    /// (its handler may own what removes others).
    pub(crate) fn remove(&mut self, id: u32) -> Option<ViewKey> {
        let i = self.list.iter().position(|k| k.binding.id == id)?;
        self.changed = true;
        Some(self.list.remove(i))
    }

    /// Binding `id`'s keystroke as written and its handler.
    pub(crate) fn handler(&self, id: u32) -> Option<(Rc<str>, KeyHandler)> {
        self.list
            .iter()
            .find(|k| k.binding.id == id)
            .map(|k| (k.text.clone(), k.handler.clone()))
    }
}
