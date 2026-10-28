//! Roving focus: a group whose items are one stop of the keyboard focus
//! (Tab), between which the arrow keys move it, as WAI-ARIA's tab list and
//! radio group patterns have it. `Tabs` and `RadioGroup` provide a group
//! through context; each `Tab` / `Radio` under one registers with it. An
//! item outside a group stays a stop of its own.
//!
//! The stop is the item the focus is on, else the current one (the
//! selected tab, the checked radio), else the first enabled one: only that
//! item is `focusable`, so Tab enters and leaves the group in one step. An
//! arrow key makes the item it moves to the stop and focuses it (a ref's
//! `focus()` only moves to stops; the `focusable` change mounts before the
//! command in the same batch), then activates it: a tab reports a press, a
//! radio asks to be checked, so the app selects it as focus moves, the
//! pattern's automatic activation. Disabled items are skipped, as they are
//! no stops. The items are in the order they were rendered, which is the
//! order of the app's children unless it inserts one between others later.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::prelude::*;

use crate::keys::bind_while;

/// What the arrow keys of a group do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pattern {
    /// A tab list: Left / Up the previous tab, Right / Down the next, Home
    /// the first, End the last. The list's axis is the app's layout, so
    /// both pairs move.
    Tabs,
    /// A radio group: Up / Left the previous radio, Down / Right the next.
    Radios,
}

/// A group's keys: each keystroke, whether a held key repeats it, and where
/// it moves the focus.
const TAB_KEYS: &[(&str, bool, Step)] = &[
    ("left", true, Step::Previous),
    ("up", true, Step::Previous),
    ("right", true, Step::Next),
    ("down", true, Step::Next),
    ("home", true, Step::First),
    ("end", true, Step::Last),
];

const RADIO_KEYS: &[(&str, bool, Step)] = &[
    ("left", true, Step::Previous),
    ("up", true, Step::Previous),
    ("right", true, Step::Next),
    ("down", true, Step::Next),
];

/// Where a key moves the focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Previous,
    Next,
    First,
    Last,
}

/// An item of a group.
struct Item {
    key: u64,
    node: ElementRef,
    /// Selected or checked.
    current: Prop<bool>,
    disabled: Prop<bool>,
    /// What moving the focus to it does besides.
    activate: Rc<dyn Fn()>,
}

/// A group of items with one stop of the keyboard focus (see the module's
/// docs).
#[derive(Clone)]
pub(crate) struct Roving(Rc<Inner>);

struct Inner {
    items: Rc<RefCell<Vec<Item>>>,
    next_key: Cell<u64>,
    /// Bumped as items come and go.
    changed: Signal<u64>,
    /// The item the keyboard focus is on, or a key just moved it to.
    focus: Signal<Option<u64>>,
    /// The item that is the stop.
    stop: Memo<Option<u64>>,
}

impl Roving {
    /// A group, with its keys bound while one of its items has the focus.
    pub(crate) fn new(pattern: Pattern) -> Self {
        let items = Rc::new(RefCell::new(Vec::<Item>::new()));
        let changed = signal(0u64);
        let focus = signal(None::<u64>);
        let stop = {
            let items = items.clone();
            computed(move || {
                changed.get();
                let items = items.borrow();
                let enabled = |i: &&Item| !i.disabled.get();
                if let Some(key) = focus.get()
                    && items.iter().filter(enabled).any(|i| i.key == key)
                {
                    return Some(key);
                }
                items
                    .iter()
                    .find(|i| i.current.get() && !i.disabled.get())
                    .or_else(|| items.iter().find(enabled))
                    .map(|i| i.key)
            })
        };
        let group = Self(Rc::new(Inner {
            items,
            next_key: Cell::new(1),
            changed,
            focus,
            stop,
        }));
        let focused = computed(move || focus.get().is_some());
        let keys = match pattern {
            Pattern::Tabs => TAB_KEYS,
            Pattern::Radios => RADIO_KEYS,
        };
        let moved = group.clone();
        bind_while(move || focused.get(), keys, move |step| moved.step(step));
        group
    }

    /// Adds an item, which the group forgets when the current owner (the
    /// item's component) ends. Its view takes the returned [`Member`].
    pub(crate) fn register(
        &self,
        node: ElementRef,
        current: Prop<bool>,
        disabled: Prop<bool>,
        activate: impl Fn() + 'static,
    ) -> Member {
        let key = self.0.next_key.get();
        self.0.next_key.set(key + 1);
        self.0.items.borrow_mut().push(Item {
            key,
            node,
            current,
            disabled,
            activate: Rc::new(activate),
        });
        self.0.changed.update(|n| *n += 1);
        let inner = self.0.clone();
        cleanup(move || {
            inner.items.borrow_mut().retain(|i| i.key != key);
            // The group may be ending too: its signals may be gone.
            if inner.focus.try_get() == Some(Some(key)) {
                inner.focus.try_set(None);
            }
            if let Some(n) = inner.changed.try_get() {
                inner.changed.try_set(n + 1);
            }
        });
        Member {
            key,
            stop: self.0.stop,
            focus: self.0.focus,
        }
    }

    /// Moves the focus by `step`, around the ends, past disabled items, and
    /// activates the item it reaches.
    fn step(&self, step: Step) {
        let target = {
            let items = self.0.items.borrow();
            let enabled: Vec<usize> = (0..items.len())
                .filter(|&i| !items[i].disabled.get_untracked())
                .collect();
            let (Some(&first), Some(&last)) = (enabled.first(), enabled.last()) else {
                return;
            };
            let from = self
                .0
                .focus
                .get_untracked()
                .and_then(|key| enabled.iter().position(|&i| items[i].key == key));
            let to = match (step, from) {
                (Step::First, _) | (Step::Next, None) => first,
                (Step::Last, _) | (Step::Previous, None) => last,
                (Step::Next, Some(at)) => enabled[(at + 1) % enabled.len()],
                (Step::Previous, Some(at)) => enabled[(at + enabled.len() - 1) % enabled.len()],
            };
            if from.is_some_and(|at| enabled[at] == to) {
                return;
            }
            let item = &items[to];
            (item.key, item.node, item.activate.clone())
        };
        let (key, node, activate) = target;
        // The stop first, so `focus()` (sent after the batch's other
        // changes) finds the item focusable.
        self.0.focus.set(Some(key));
        node.focus();
        activate();
    }
}

/// An item's side of its group: whether it is the stop, and the focus it
/// reports.
#[derive(Clone, Copy)]
pub(crate) struct Member {
    key: u64,
    stop: Memo<Option<u64>>,
    focus: Signal<Option<u64>>,
}

impl Member {
    /// Whether the item is the group's stop of the keyboard focus (its
    /// view's `focusable`).
    pub(crate) fn is_stop(&self) -> bool {
        self.stop.get() == Some(self.key)
    }

    /// The keyboard focus reached the item.
    pub(crate) fn focused(&self) {
        self.focus.try_set(Some(self.key));
    }

    /// The keyboard focus left the item (unless a key already moved it to
    /// another of the group).
    pub(crate) fn blurred(&self) {
        if self.focus.try_get() == Some(Some(self.key)) {
            self.focus.try_set(None);
        }
    }
}

/// Puts an item in its group, when it is in one: the view is the group's
/// stop only while it is the item the focus is on or would enter at, and
/// reports the focus to the group.
pub(crate) fn member<V: Interactive>(view: V, node: &ElementRef, member: Option<Member>) -> V {
    let view = view.element_ref(node);
    match member {
        Some(m) => view
            .focusable(move || m.is_stop())
            .on_focus(move || m.focused())
            .on_blur(move || m.blurred()),
        None => view,
    }
}
