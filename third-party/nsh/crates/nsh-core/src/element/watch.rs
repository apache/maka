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
//!
//! Views also watch the order of elements they did not make
//! ([`super::watch_order`]): a toolbar's items, wherever they are in it.
//! Components render in the order the core makes them, not the tree's (an
//! item inside a group renders after the toolbar's later children), so a
//! group that moves the focus between its items asks the core for their
//! order. Such a watch costs nothing until it is invalidated (an item came)
//! or a node moves; the core then puts its elements in tree order at the
//! end of the round.

use std::{cell::Cell, rc::Rc};

use crate::{
    NodeId,
    element::{ElementRef, events::ScrollEvent},
};

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

/// An order watch's handler: the order of the elements, as indices into
/// the list it was given.
pub(crate) type OrderHandler = Rc<dyn Fn(&[usize])>;

/// What an order watch asks for its elements when the core looks.
pub(crate) type OrderElements = Rc<dyn Fn() -> Vec<ElementRef>>;

/// One view's watch of the order of elements.
pub(crate) struct Order {
    pub(crate) id: u32,
    /// The elements, asked when the core looks.
    pub(crate) elements: OrderElements,
    pub(crate) handler: OrderHandler,
    /// Whether the core looks at the end of the round.
    pub(crate) dirty: Rc<Cell<bool>>,
}

/// The views' watches, oldest first.
#[derive(Default)]
pub(crate) struct Watches {
    next: u32,
    pub(crate) list: Vec<Watch>,
    pub(crate) orders: Vec<Order>,
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

    /// Adds an order watch, to look at in this round; its id and its flag.
    pub(crate) fn add_order(
        &mut self,
        elements: Rc<dyn Fn() -> Vec<ElementRef>>,
        handler: OrderHandler,
    ) -> (u32, Rc<Cell<bool>>) {
        let id = self.next;
        self.next += 1;
        let dirty = Rc::new(Cell::new(true));
        self.orders.push(Order {
            id,
            elements,
            handler,
            dirty: dirty.clone(),
        });
        (id, dirty)
    }

    /// Removes order watch `id`; returns it so it is dropped outside the
    /// borrow.
    pub(crate) fn remove_order(&mut self, id: u32) -> Option<Order> {
        let i = self.orders.iter().position(|w| w.id == id)?;
        Some(self.orders.remove(i))
    }

    /// Whether an order watch waits to be looked at.
    pub(crate) fn orders_dirty(&self) -> bool {
        self.orders.iter().any(|o| o.dirty.get())
    }
}

/// A watch of the order of elements ([`super::watch_order`]): tells the
/// core to look at it again.
#[doc(hidden)]
#[derive(Clone)]
pub struct OrderWatch {
    dirty: Rc<Cell<bool>>,
}

impl OrderWatch {
    pub(crate) fn new(dirty: Rc<Cell<bool>>) -> Self {
        Self { dirty }
    }

    /// The elements changed (one came): the core puts them in tree order at
    /// the end of this commit round, and the handler hears it in the same
    /// batch.
    pub fn invalidate(&self) {
        self.dirty.set(true);
    }
}

impl std::fmt::Debug for OrderWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrderWatch")
            .field("dirty", &self.dirty.get())
            .finish()
    }
}
