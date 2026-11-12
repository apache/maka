//! Menus of views ([`super::desktop::set_application_menu`],
//! [`super::desktop::popup_menu`]; TS: `Menu.setApplicationMenu`,
//! `Menu.popup`).
//!
//! A view's menu is decoded into [`crate::desktop::MenuItem`]s with an id
//! per item that has a handler, the handlers kept here by id. The platform
//! reports a chosen item as the root's `Menu` event; the core runs a view's
//! handler itself and leaves the others to JS. Views' item ids start at
//! [`FIRST_ID`], above any JS gives, so the two never meet. A context menu
//! closing is reported to both sides: each settles the one it showed.

use std::rc::Rc;

use super::task::AnswerSlot;
use crate::{
    desktop::Shortcut,
    geometry::{Bounds, Points},
};

/// A menu item's handler.
pub(crate) type MenuHandler = Rc<dyn Fn()>;

/// The first id of a view's menu item.
pub(crate) const FIRST_ID: u32 = 1 << 31;

/// The views' menu handlers.
#[derive(Default)]
pub(crate) struct ViewMenus {
    next: u32,
    /// The application menu's handlers, by id.
    pub(crate) app: Vec<(u32, MenuHandler)>,
    /// Counts the application menus set, so the owner of one replaced
    /// leaves the new one's handlers when it goes.
    pub(crate) app_generation: u64,
    /// The last context menu's handlers.
    pub(crate) popup: Vec<(u32, MenuHandler)>,
    /// Counts the context menus shown, as `app_generation`.
    pub(crate) popup_generation: u64,
    /// Settles the context menu shown, once the platform reports it closed.
    pub(crate) closed: Option<AnswerSlot<()>>,
    /// The tray's menu handlers.
    pub(crate) tray: Vec<(u32, MenuHandler)>,
    /// The tray click's id and handler.
    pub(crate) tray_click: Option<(u32, TrayClickHandler)>,
    /// Counts the trays set, as `app_generation`.
    pub(crate) tray_generation: u64,
    /// The global shortcuts registered.
    pub(crate) globals: Vec<Global>,
}

/// The tray click's handler, given the icon's frame on the screen.
pub(crate) type TrayClickHandler = Rc<dyn Fn(Option<Bounds<Points>>)>;

/// A global shortcut a view registered.
pub(crate) struct Global {
    pub(crate) id: u32,
    pub(crate) shortcut: Shortcut,
    pub(crate) on_press: MenuHandler,
    /// Settled with whether the system took it, once it says.
    pub(crate) registered: Option<AnswerSlot<bool>>,
}

impl ViewMenus {
    /// A new item id.
    pub(crate) fn next_id(&mut self) -> u32 {
        let id = FIRST_ID + self.next;
        self.next = self.next.wrapping_add(1) % FIRST_ID;
        id
    }

    /// Item `id`'s handler.
    pub(crate) fn handler(&self, id: u32) -> Option<MenuHandler> {
        self.app
            .iter()
            .chain(&self.popup)
            .chain(&self.tray)
            .find(|(i, _)| *i == id)
            .map(|(_, h)| h.clone())
            .or_else(|| {
                self.globals
                    .iter()
                    .find(|g| g.id == id)
                    .map(|g| g.on_press.clone())
            })
    }

    /// The tray click's handler, when `id` is its.
    pub(crate) fn tray_click(&self, id: u32) -> Option<TrayClickHandler> {
        self.tray_click
            .as_ref()
            .filter(|(i, _)| *i == id)
            .map(|(_, h)| h.clone())
    }

    /// Settles global shortcut `id`'s registration; one the system refused
    /// is forgotten.
    pub(crate) fn registered(&mut self, id: u32, registered: bool) {
        let Some(index) = self.globals.iter().position(|g| g.id == id) else {
            return;
        };
        if let Some(slot) = self.globals[index].registered.take() {
            slot.borrow_mut().deliver(registered);
        }
        if !registered {
            self.globals.remove(index);
        }
    }

    /// Settles the context menu shown, if there is one.
    pub(crate) fn settle_popup(&mut self) {
        if let Some(slot) = self.closed.take() {
            slot.borrow_mut().deliver(());
        }
    }
}
