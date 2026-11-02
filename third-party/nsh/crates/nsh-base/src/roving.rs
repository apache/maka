//! Roving focus: a group whose items are one stop of the keyboard focus
//! (Tab), between which the arrow keys move it, as WAI-ARIA's tab list,
//! radio group and toolbar patterns have it. `Tabs`, `RadioGroup`,
//! `ToggleGroup` and `Toolbar` provide a group through context; each
//! `Tab` / `Radio` under one, and each `Toggle`, `Button` and `Link` under
//! a toolbar or a toggle group (a [`Bar`]), registers with it. An item
//! outside a group stays a stop of its own.
//!
//! The stop is the item the focus is on, else (a toolbar) the item it last
//! left or (the others) the current one (the selected tab, the checked
//! radio, the first pressed toggle), else the first enabled one: only that
//! item is `focusable`, so Tab enters and leaves the group in one step. An
//! arrow key makes the item it moves to the stop and focuses it (a ref's
//! `focus()` only moves to stops; the `focusable` change mounts before the
//! command in the same batch), then activates it: a tab reports a press, a
//! radio asks to be checked, so the app selects it as focus moves, the
//! pattern's automatic activation (a toolbar's items do nothing: the focus
//! only moves). Disabled items are skipped, as they are no stops. The items
//! are in the tree's order: components render in the order the core makes
//! them (an item inside a toolbar's group, or a popover's trigger, renders
//! after the toolbar's later children), so the group asks the core to put
//! them in order as they come and as the app moves them (`watch_order`), in
//! the batch they come or move in.
//!
//! Each item's view reads a flag of its own, which the group sets when the
//! stop changes: moving the focus runs the bindings of the item it left and
//! the item it reached, however many items the group has.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    element::{OrderWatch, watch_order},
    geometry::Axis,
    prelude::*,
};

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
    /// A toggle group on its own: the keys of a tab list (its axis is the
    /// app's layout, so both pairs move; Home and End the first and last
    /// toggle).
    Toggles,
    /// A toolbar along its axis: Left / Right (a row) or Up / Down (a
    /// column) the previous and next item, Home and End the first and
    /// last; the other pair is left to the items (a menu's trigger opens
    /// it with Down). Tab comes back to the item the focus last left.
    Toolbar(Axis),
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

const ROW_KEYS: &[(&str, bool, Step)] = &[
    ("left", true, Step::Previous),
    ("right", true, Step::Next),
    ("home", true, Step::First),
    ("end", true, Step::Last),
];

const COLUMN_KEYS: &[(&str, bool, Step)] = &[
    ("up", true, Step::Previous),
    ("down", true, Step::Next),
    ("home", true, Step::First),
    ("end", true, Step::Last),
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
    /// Whether it is the stop: what its view reads.
    is_stop: Signal<bool>,
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
    /// The item the keyboard focus was on last.
    last: Signal<Option<u64>>,
    /// Puts the items in the tree's order as they come.
    order: OrderWatch,
}

impl Roving {
    /// A group, with its keys bound while one of its items has the focus.
    pub(crate) fn new(pattern: Pattern) -> Self {
        let items = Rc::new(RefCell::new(Vec::<Item>::new()));
        let changed = signal(0u64);
        let focus = signal(None::<u64>);
        let last = signal(None::<u64>);
        let toolbar = matches!(pattern, Pattern::Toolbar(_));
        let stop = {
            let items = items.clone();
            computed(move || {
                changed.get();
                let items = items.borrow();
                let enabled = |key: u64| items.iter().any(|i| i.key == key && !i.disabled.get());
                if let Some(key) = focus.get()
                    && enabled(key)
                {
                    return Some(key);
                }
                if toolbar {
                    if let Some(key) = last.get()
                        && enabled(key)
                    {
                        return Some(key);
                    }
                } else if let Some(item) =
                    items.iter().find(|i| i.current.get() && !i.disabled.get())
                {
                    return Some(item.key);
                }
                items.iter().find(|i| !i.disabled.get()).map(|i| i.key)
            })
        };
        // Tells the item that stops being the stop and the one that becomes
        // it, and no other.
        {
            let items = items.clone();
            let shown = Cell::new(None::<u64>);
            effect(move || {
                let next = stop.get();
                let prev = shown.replace(next);
                if prev == next {
                    return;
                }
                let flags: Vec<(Signal<bool>, bool)> = items
                    .borrow()
                    .iter()
                    .filter_map(|i| {
                        let key = Some(i.key);
                        (key == prev || key == next).then_some((i.is_stop, key == next))
                    })
                    .collect();
                for (flag, on) in flags {
                    flag.try_set(on);
                }
            });
        }
        let order = {
            let (listed, sorted) = (items.clone(), items.clone());
            watch_order(
                move || listed.borrow().iter().map(|i| i.node).collect(),
                move |order| {
                    {
                        let mut items = sorted.borrow_mut();
                        let mut taken: Vec<Option<Item>> = items.drain(..).map(Some).collect();
                        items.extend(order.iter().filter_map(|&i| taken[i].take()));
                    }
                    changed.update(|n| *n += 1);
                },
            )
        };
        let group = Self(Rc::new(Inner {
            items,
            next_key: Cell::new(1),
            changed,
            focus,
            last,
            order,
        }));
        let focused = computed(move || focus.get().is_some());
        let keys = match pattern {
            Pattern::Tabs | Pattern::Toggles => TAB_KEYS,
            Pattern::Radios => RADIO_KEYS,
            Pattern::Toolbar(Axis::Horizontal) => ROW_KEYS,
            Pattern::Toolbar(Axis::Vertical) => COLUMN_KEYS,
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
        let is_stop = signal(false);
        self.0.items.borrow_mut().push(Item {
            key,
            node,
            current,
            disabled,
            is_stop,
            activate: Rc::new(activate),
        });
        self.0.changed.update(|n| *n += 1);
        self.0.order.invalidate();
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
            is_stop,
            focus: self.0.focus,
            last: self.0.last,
        }
    }

    /// The element of the current item (the selected tab), the first when
    /// several are; read in a computation, which runs again as items come
    /// and go and as they become current or stop being it.
    pub(crate) fn current(&self) -> Option<ElementRef> {
        self.0.changed.get();
        let items = self.0.items.borrow();
        items.iter().find(|i| i.current.get()).map(|i| i.node)
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
        batch(|| {
            self.0.focus.set(Some(key));
            self.0.last.set(Some(key));
        });
        node.focus();
        activate();
    }
}

/// An item's side of its group: whether it is the stop, and the focus it
/// reports.
#[derive(Clone, Copy)]
pub(crate) struct Member {
    key: u64,
    is_stop: Signal<bool>,
    focus: Signal<Option<u64>>,
    last: Signal<Option<u64>>,
}

impl Member {
    /// Whether the item is the group's stop of the keyboard focus (its
    /// view's `focusable`).
    pub(crate) fn is_stop(&self) -> bool {
        self.is_stop.get()
    }

    /// The keyboard focus reached the item.
    pub(crate) fn focused(&self) {
        batch(|| {
            self.focus.try_set(Some(self.key));
            self.last.try_set(Some(self.key));
        });
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

/// A toolbar's group, or a toggle group's on its own: what the `Toggle`s,
/// `Button`s and `Link`s inside it join, a [`ToolbarGroup`] or a
/// [`ToggleGroup`] inside a toolbar included.
///
/// [`ToolbarGroup`]: crate::ToolbarGroup
/// [`ToggleGroup`]: crate::ToggleGroup
#[derive(Clone)]
pub(crate) struct Bar {
    pub(crate) roving: Roving,
    /// Every item inside is disabled.
    pub(crate) disabled: Prop<bool>,
    /// The toolbar's axis (`None`: a toggle group on its own), which its
    /// groups lay out along.
    pub(crate) axis: Option<Axis>,
}

/// What [`bar`] finds: a bar, or `None` below a popup a bar's item opens
/// (its content is no part of the bar).
#[derive(Clone)]
struct BarContext(Option<Bar>);

/// The bar around the current component, if any.
pub(crate) fn bar() -> Option<Bar> {
    use_context::<BarContext>().and_then(|BarContext(bar)| bar)
}

/// Makes `bar` the one of what the current owner makes from now on.
pub(crate) fn provide_bar(bar: Bar) {
    provide_context(BarContext(Some(bar)));
}

/// Leaves the bar around the current owner, if any, for what it makes from
/// now on: a popup's content (a popover's buttons, a sheet's) is a
/// region of its own, whose controls are stops of their own, though the
/// popup's trigger is an item of the bar.
pub(crate) fn leave_bar() {
    if bar().is_some() {
        provide_context(BarContext(None));
    }
}

/// A part of a bar that holds items (a [`ToggleGroup`] or a
/// [`ToolbarGroup`] inside a toolbar): the same group of the focus, its
/// items disabled with the bar's too.
///
/// [`ToggleGroup`]: crate::ToggleGroup
/// [`ToolbarGroup`]: crate::ToolbarGroup
pub(crate) fn nested_bar(outer: Bar, disabled: Prop<bool>) -> Bar {
    let all = outer.disabled;
    Bar {
        disabled: Prop::bind(move || disabled.get() || all.get()),
        ..outer
    }
}

/// Puts an item's view in the bar around it, when there is one: one of its
/// stops of the keyboard focus, disabled with the bar too. Returns the view
/// and its `disabled`, the item's own with the bar's. `current` makes it
/// where Tab enters a toggle group on its own (a pressed toggle).
pub(crate) fn bar_item<V: Interactive>(
    view: V,
    current: Option<Prop<bool>>,
    disabled: Prop<bool>,
) -> (V, Prop<bool>) {
    let Some(bar) = bar() else {
        return (view, disabled);
    };
    let all = bar.disabled;
    let disabled = Prop::bind(move || disabled.get() || all.get());
    let current = current.unwrap_or_else(|| Prop::new(false));
    let node = element_ref();
    let item = bar.roving.register(node, current, disabled, || {});
    (member(view, &node, Some(item)), disabled)
}

/// Puts a popup's trigger in the bar around the popup, when there is one:
/// the element a `Popover` or a `Menu` gives its presses (the app's view in
/// its `trigger` slot) is one of the bar's items, whose node is the ref the
/// popup anchors to, disabled with the bar. Read `bar` where the popup is
/// made: the trigger's slot is placed in a region of the popup's own.
pub(crate) fn bar_trigger<V: Interactive>(bar: Option<Bar>, view: V, node: ElementRef) -> V {
    let Some(bar) = bar else {
        return view;
    };
    let disabled = bar.disabled;
    let item = bar.roving.register(node, Prop::new(false), disabled, || {});
    member(view, &node, Some(item)).disabled(disabled)
}
