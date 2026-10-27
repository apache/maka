//! Elements that change: [`dynamic`], [`when`] and [`each`] (TS:
//! `{() => …}`, `<If>`, `<Each>`).
//!
//! Each is a region of its parent's children and a binding: when what it
//! reads changes, its elements are made again (a [`when`]'s only when its
//! condition flips; an [`each`]'s only for the rows that came, keeping the
//! others) and the core reconciles the region's nodes alone.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    hash::Hash,
    rc::Rc,
};

use super::{
    AnyElement, IntoElement, IntoReactive, Owner, Reactive, ReadSignal, Signal, SignalEquals,
    builder::ElKind, cleanup, computed, create_root, signal, signal_with, untracked,
};
use crate::Tag;

/// What a region shows, and how it changes.
#[derive(Clone)]
pub(crate) enum Region {
    /// Made again whenever what it read changes.
    Dynamic(Rc<dyn Fn() -> Vec<AnyElement>>),
    /// One branch or the other, made again when the condition flips.
    If {
        when: Reactive<bool>,
        then: Rc<dyn Fn() -> Vec<AnyElement>>,
        otherwise: Option<Rc<dyn Fn() -> Vec<AnyElement>>>,
    },
    /// A row per item, by key.
    Each(Rc<dyn EachRows>),
    /// A view, or its fallback once something under it failed.
    Catch {
        view: Rc<dyn Fn() -> Vec<AnyElement>>,
        fallback: Rc<dyn Fn(super::ComponentError, Reset) -> Vec<AnyElement>>,
    },
}

/// An element of a region's new run: one made in this run (with the owner
/// its bindings belong to), or one kept from before ([`ElKind::Keep`]).
pub(crate) struct RegionElement {
    pub(crate) owner: Option<Owner>,
    pub(crate) element: AnyElement,
    /// Whether the run that made it is still the region's current one
    /// (none: an [`Each`]'s, whose rows go with their owners).
    pub(crate) current: Option<Current>,
}

impl RegionElement {
    /// Whether it can still be applied: the run that made it was not
    /// replaced, nor its row disposed, before the core applied it (a
    /// listener that flips a branch there and back queues both runs; what
    /// the first made, its props too, went with it).
    pub(crate) fn applies(&self) -> bool {
        self.current.as_ref().is_none_or(Current::holds)
            && self.owner.is_none_or(|owner| owner.is_live())
    }
}

/// Whether a run of a region is still its current one: ends when the
/// region runs again or goes (the run's owner cleans up).
#[derive(Clone)]
pub(crate) struct Current(Rc<Cell<bool>>);

impl Current {
    /// The run under way's (in the region's binding).
    fn of_run() -> Self {
        let current = Rc::new(Cell::new(true));
        let ended = current.clone();
        cleanup(move || ended.set(false));
        Current(current)
    }

    fn holds(&self) -> bool {
        self.0.get()
    }
}

impl Region {
    /// Makes the region a binding under the current owner: `show` gets its
    /// elements now and each time they change.
    pub(crate) fn bind(&self, show: Rc<dyn Fn(Vec<RegionElement>)>) {
        match self {
            Region::Dynamic(f) => {
                let f = f.clone();
                super::reactive::render_effect(move || {
                    let owner = Owner::current();
                    let current = Current::of_run();
                    let elements = f()
                        .into_iter()
                        .map(|element| RegionElement {
                            owner: Some(owner),
                            element,
                            current: Some(current.clone()),
                        })
                        .collect();
                    show(elements);
                });
            }
            Region::If {
                when,
                then,
                otherwise,
            } => {
                // The branch is made again only when the condition flips.
                let when = when.clone();
                let condition = computed(move || when.get());
                let (then, otherwise) = (then.clone(), otherwise.clone());
                super::reactive::render_effect(move || {
                    let branch = if condition.get() {
                        Some(&then)
                    } else {
                        otherwise.as_ref()
                    };
                    let owner = Owner::current();
                    let current = Current::of_run();
                    let elements = untracked(|| branch.map(|f| f()).unwrap_or_default())
                        .into_iter()
                        .map(|element| RegionElement {
                            owner: Some(owner),
                            element,
                            current: Some(current.clone()),
                        })
                        .collect();
                    show(elements);
                });
            }
            Region::Each(rows) => rows.clone().bind(show),
            Region::Catch { view, fallback } => {
                let (view, fallback) = (view.clone(), fallback.clone());
                let failed = signal_with(None::<super::ComponentError>, SignalEquals::Never);
                super::reactive::render_effect(move || {
                    let error = failed.get();
                    // The view is under the boundary, the fallback is not
                    // (what fails in it goes to the boundary above).
                    if error.is_none() {
                        super::reactive::register_boundary(failed);
                    }
                    let owner = Owner::current();
                    let current = Current::of_run();
                    let elements = untracked(|| match error {
                        Some(error) => fallback(error, Reset(failed)),
                        None => view(),
                    })
                    .into_iter()
                    .map(|element| RegionElement {
                        owner: Some(owner),
                        element,
                        current: Some(current.clone()),
                    })
                    .collect();
                    show(elements);
                });
            }
        }
    }
}

/// What can be a region's elements: one element, none (`()`), an
/// `Option`, a `Vec` or an array of them.
pub trait IntoElements {
    /// As elements.
    fn into_elements(self) -> Vec<AnyElement>;
}

impl<T: IntoElement> IntoElements for T {
    fn into_elements(self) -> Vec<AnyElement> {
        vec![self.into_element()]
    }
}

impl<T: IntoElement> IntoElements for Option<T> {
    fn into_elements(self) -> Vec<AnyElement> {
        self.map(IntoElement::into_element).into_iter().collect()
    }
}

impl<T: IntoElement> IntoElements for Vec<T> {
    fn into_elements(self) -> Vec<AnyElement> {
        self.into_iter().map(IntoElement::into_element).collect()
    }
}

impl<T: IntoElement, const N: usize> IntoElements for [T; N] {
    fn into_elements(self) -> Vec<AnyElement> {
        self.into_iter().map(IntoElement::into_element).collect()
    }
}

impl IntoElements for () {
    fn into_elements(self) -> Vec<AnyElement> {
        Vec::new()
    }
}

fn region(region: Region) -> AnyElement {
    let mut node = super::ElNode::new(Tag::View);
    node.kind = ElKind::Region(region);
    AnyElement(node)
}

/// Elements made again whenever what `f` reads changes (TS: a child that is
/// a function, `{() => …}`). Prefer [`when`] for a choice and [`each`] for a
/// list: they keep what did not change.
pub fn dynamic<E: IntoElements>(f: impl Fn() -> E + 'static) -> AnyElement {
    region(Region::Dynamic(Rc::new(move || f().into_elements())))
}

/// `view`'s elements, or `fallback`'s once something under them failed (a
/// panic in a binding, a listener, an effect or a component's view, TS:
/// `<ErrorBoundary>`): the failed part goes, and the fallback shows the
/// error; its [`Reset`] makes the view again. What fails in the fallback
/// goes to the boundary above.
pub fn catch_error<E: IntoElements, F: IntoElements>(
    view: impl Fn() -> E + 'static,
    fallback: impl Fn(super::ComponentError, Reset) -> F + 'static,
) -> AnyElement {
    region(Region::Catch {
        view: Rc::new(move || view().into_elements()),
        fallback: Rc::new(move |error, reset| fallback(error, reset).into_elements()),
    })
}

/// What tries a [`catch_error`]'s view again (TS: the fallback's `reset`).
#[derive(Clone, Copy)]
pub struct Reset(Signal<Option<super::ComponentError>>);

impl Reset {
    /// Makes the view again, in place of the fallback.
    pub fn reset(&self) {
        self.0.set(None);
    }
}

/// `then`'s elements while a condition holds, else `otherwise`'s (TS: `<If
/// when={…} else={…}>`), made by [`when`]. A branch is made when the
/// condition flips to it, and what it made goes when it flips away.
pub struct If {
    when: Reactive<bool>,
    then: Rc<dyn Fn() -> Vec<AnyElement>>,
    otherwise: Option<Rc<dyn Fn() -> Vec<AnyElement>>>,
}

impl If {
    /// `then` while `when` holds, as [`when`] makes it.
    #[deprecated(note = "use `when(condition, then)`, as `view()` makes a view")]
    pub fn new<E: IntoElements>(
        when: impl IntoReactive<bool>,
        then: impl Fn() -> E + 'static,
    ) -> Self {
        self::when(when, then)
    }

    /// `otherwise` while the condition does not hold (TS: `else={…}`).
    pub fn otherwise<E: IntoElements>(mut self, otherwise: impl Fn() -> E + 'static) -> Self {
        self.otherwise = Some(Rc::new(move || otherwise().into_elements()));
        self
    }
}

/// `then`'s elements while `condition` (a value, a signal or a closure)
/// holds (TS: `<If when={…}>`); [`If::otherwise`] adds what shows while it
/// does not (TS: `else={…}`). A branch is made when the condition flips to
/// it, and what it made goes when it flips away.
///
/// GPUI has no counterpart: its views render again on every change, so a
/// branch there is decided in each render, with `FluentBuilder::when` /
/// `when_else` (NSH's [`super::FluentBuilder`] is that, decided once). NSH's
/// components run once (`docs/dev/reactive-components.md`), so what comes
/// and goes is a region bound to its condition: this one, named after TSX's
/// `<If when>`, its other branch `otherwise` as `else` is a keyword.
pub fn when<E: IntoElements>(
    condition: impl IntoReactive<bool>,
    then: impl Fn() -> E + 'static,
) -> If {
    If {
        when: condition.into_reactive(),
        then: Rc::new(move || then().into_elements()),
        otherwise: None,
    }
}

impl IntoElement for If {
    fn into_element(self) -> AnyElement {
        region(Region::If {
            when: self.when,
            then: self.then,
            otherwise: self.otherwise,
        })
    }
}

/// A row per item of a list, identified by key (TS: `<Each of={…}
/// key="id">{(item, index) => …}</Each>`), made by [`each`].
pub struct Each;

impl Each {
    /// The rows of `items`, as [`each`] makes them.
    #[deprecated(note = "use `each(items, key, row)`, as `view()` makes a view")]
    #[allow(clippy::new_ret_no_self, reason = "TS's <Each> is an element")]
    pub fn new<T, K, E>(
        items: impl IntoReactive<Vec<T>>,
        key: impl Fn(&T) -> K + 'static,
        row: impl Fn(ReadSignal<T>, ReadSignal<usize>) -> E + 'static,
    ) -> AnyElement
    where
        T: Clone + PartialEq + 'static,
        K: Hash + Eq + Clone + 'static,
        E: IntoElements,
    {
        each(items, key, row)
    }
}

/// A row per item of `items` (a value, a signal or a closure), each made by
/// `row(item, index)` and known by `key(item)` (TS: `<Each of={…}
/// key="id">{(item, index) => …}</Each>`). A row is made when its key comes
/// and goes with it; one that stays keeps its nodes and bindings, and gets
/// its item and index as signals that follow it.
pub fn each<T, K, E>(
    items: impl IntoReactive<Vec<T>>,
    key: impl Fn(&T) -> K + 'static,
    row: impl Fn(ReadSignal<T>, ReadSignal<usize>) -> E + 'static,
) -> AnyElement
where
    T: Clone + PartialEq + 'static,
    K: Hash + Eq + Clone + 'static,
    E: IntoElements,
{
    region(Region::Each(Rc::new(Rows {
        items: items.into_reactive(),
        key: Box::new(key),
        row: Box::new(move |item, index| row(item, index).into_elements()),
        state: RefCell::new(Vec::new()),
        next: Cell::new(0),
    })))
}

/// The rows of an [`Each`], with their type erased.
pub(crate) trait EachRows {
    /// Binds the rows (see [`Region::bind`]).
    fn bind(self: Rc<Self>, show: Rc<dyn Fn(Vec<RegionElement>)>);
}

/// What makes a row's elements from its item and index.
type RowFn<T> = Box<dyn Fn(ReadSignal<T>, ReadSignal<usize>) -> Vec<AnyElement>>;

struct Rows<T: 'static, K> {
    items: Reactive<Vec<T>>,
    key: Box<dyn Fn(&T) -> K>,
    row: RowFn<T>,
    /// The live rows, in order.
    state: RefCell<Vec<Row<T, K>>>,
    /// The id of the next row made (its elements' keys).
    next: Cell<u64>,
}

struct Row<T: 'static, K> {
    key: K,
    id: u64,
    item: Signal<T>,
    index: Signal<usize>,
    owner: Owner,
    /// How many elements it made.
    count: usize,
}

/// The key of a row's `i`th element: unique to the row, whatever its key.
fn element_key(id: u64, i: usize) -> super::SharedString {
    format!("\u{1}{id}.{i}").into()
}

impl<T: Clone + PartialEq + 'static, K: Hash + Eq + Clone + 'static> EachRows for Rows<T, K> {
    fn bind(self: Rc<Self>, show: Rc<dyn Fn(Vec<RegionElement>)>) {
        // The rows go with the region's owner.
        let rows = self.clone();
        cleanup(move || {
            for row in rows.state.take() {
                row.owner.dispose();
            }
        });
        super::reactive::render_effect(move || {
            let items = self.items.get();
            let out = untracked(|| self.update(items));
            show(out);
        });
    }
}

impl<T: Clone + PartialEq + 'static, K: Hash + Eq + Clone + 'static> Rows<T, K> {
    /// The rows of `items`: the rows of keys that stay are kept (their item
    /// and index updated), new ones made, the others disposed.
    fn update(&self, items: Vec<T>) -> Vec<RegionElement> {
        let mut old: HashMap<K, Row<T, K>> = self
            .state
            .take()
            .into_iter()
            .map(|row| (row.key.clone(), row))
            .collect();
        let mut rows = Vec::with_capacity(items.len());
        let mut out = Vec::new();
        for (index, item) in items.into_iter().enumerate() {
            let key = (self.key)(&item);
            // A key twice: the second is a row of its own.
            match old.remove(&key) {
                Some(row) => {
                    row.item.set(item);
                    row.index.set(index);
                    for i in 0..row.count {
                        let mut kept = super::ElNode::new(Tag::View);
                        kept.kind = ElKind::Keep;
                        kept.key = Some(element_key(row.id, i));
                        out.push(RegionElement {
                            owner: None,
                            element: AnyElement(kept),
                            current: None,
                        });
                    }
                    rows.push(row);
                }
                None => {
                    let id = self.next.get();
                    self.next.set(id + 1);
                    let (owner, (item, index, elements)) = create_root(|| {
                        let item = signal(item);
                        let index = signal(index);
                        let elements = (self.row)(item.read_only(), index.read_only());
                        (item, index, elements)
                    });
                    let count = elements.len();
                    for (i, mut element) in elements.into_iter().enumerate() {
                        element.0.key = Some(element_key(id, i));
                        out.push(RegionElement {
                            owner: Some(owner),
                            element,
                            current: None,
                        });
                    }
                    rows.push(Row {
                        key,
                        id,
                        item,
                        index,
                        owner,
                        count,
                    });
                }
            }
        }
        for row in old.into_values() {
            row.owner.dispose();
        }
        self.state.replace(rows);
        out
    }
}
