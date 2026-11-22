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
    AnyElement, ElNode, IntoElement, IntoReactive, Owner, Reactive, ReadSignal, SharedString,
    Signal, SignalEquals, builder::ElKind, cleanup, computed, create_root, signal, signal_with,
    untracked,
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

/// An element of a region's new run.
pub(crate) enum RegionElement {
    /// Made in this run, with the owner its bindings belong to: the run's,
    /// or its row's. (Boxed: a run of an [`each`] is mostly rows kept, and
    /// the list of them is made on every update.)
    Made { owner: Owner, element: Box<ElNode> },
    /// The element of this key stays as it is: of a row of an [`each`] that
    /// was there before.
    Kept(SharedString),
}

impl RegionElement {
    fn made(owner: Owner, element: AnyElement) -> Self {
        Self::Made {
            owner,
            element: Box::new(element.0),
        }
    }

    /// Whether it can still be applied: the run that made it was not
    /// replaced, nor its row disposed, before the core applied it (a
    /// listener that flips a branch there and back queues both runs; what
    /// the first made, its props too, went with it).
    pub(crate) fn applies(&self) -> bool {
        match self {
            Self::Made { owner, .. } => owner.is_live(),
            Self::Kept(_) => true,
        }
    }
}

/// An owner of its own for a run of a region, under its binding: what the
/// run makes (signals, the listeners and bindings of its elements, tasks)
/// is its and goes when the region runs again or goes, while the binding
/// stays, as an [`each`]'s rows are theirs. A node of a replaced run keeps
/// its handlers until the core reconciles the region, in the commit; an
/// event already queued for it then finds its listener's owner gone.
fn run_owner() -> Owner {
    let (owner, ()) = create_root(|| ());
    cleanup(move || owner.dispose());
    owner
}

impl Region {
    /// Makes the region a binding under the current owner: `show` gets its
    /// elements now and each time they change.
    pub(crate) fn bind(&self, show: Rc<dyn Fn(Vec<RegionElement>)>) {
        match self {
            Region::Dynamic(f) => {
                let f = f.clone();
                super::reactive::render_effect(move || {
                    let owner = run_owner();
                    // `scope` keeps the binding tracking what `f` reads.
                    let elements = owner
                        .scope(|| f())
                        .into_iter()
                        .map(|element| RegionElement::made(owner, element))
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
                    let owner = run_owner();
                    let elements =
                        untracked(|| owner.scope(|| branch.map(|f| f()).unwrap_or_default()))
                            .into_iter()
                            .map(|element| RegionElement::made(owner, element))
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
                    let boundary = error
                        .is_none()
                        .then(|| super::reactive::register_boundary(failed));
                    let owner = run_owner();
                    let elements = untracked(|| {
                        owner.scope(|| {
                            if let Some(boundary) = boundary {
                                super::reactive::provide_context(boundary);
                            }
                            match error {
                                Some(error) => fallback(error, Reset(failed)),
                                None => view(),
                            }
                        })
                    })
                    .into_iter()
                    .map(|element| RegionElement::made(owner, element))
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
        distinct: Cell::new(true),
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
    /// Whether the rows' keys are known to differ from each other: a row
    /// whose key comes in its place again is then the row of that key,
    /// found without a map of them all ([`Rows::update`]).
    distinct: Cell<bool>,
    /// The id of the next row made (its elements' keys).
    next: Cell<u64>,
}

struct Row<T: 'static, K> {
    key: K,
    item: Signal<T>,
    index: Signal<usize>,
    owner: Owner,
    /// The keys of the elements it made.
    elements: Box<[SharedString]>,
}

/// How many rows made in one update are looked for among the others, each
/// key compared with every other, to know the keys still differ; past it
/// the next update finds out with its map.
const MADE_COMPARED: usize = 8;

/// The key of a row's `i`th element: unique to the row, whatever its key.
fn element_key(id: u64, i: usize) -> SharedString {
    format!("\u{1}{id}.{i}").into()
}

/// Keeps a row's elements, of the keys `elements`, where they are, in
/// `out`. Out of line, as [`show_row`]: [`Rows::update`] is made for every
/// item and key type.
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn keep_row(out: &mut Vec<RegionElement>, elements: &[SharedString]) {
    out.extend(elements.iter().cloned().map(RegionElement::Kept));
}

/// Adds the elements a new row `id`, of `owner`, made to `out`; their keys.
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn show_row(
    out: &mut Vec<RegionElement>,
    id: u64,
    owner: Owner,
    elements: Vec<AnyElement>,
) -> Box<[SharedString]> {
    elements
        .into_iter()
        .enumerate()
        .map(|(i, mut element)| {
            let key = element_key(id, i);
            element.0.key = Some(key.clone());
            out.push(RegionElement::made(owner, element));
            key
        })
        .collect()
}

/// Writes `value` to `signal` unless it holds an equal one, which a write
/// would only compare and drop: a row that stays is mostly as it was.
fn follow<V: PartialEq + 'static>(signal: Signal<V>, value: V) {
    if !signal.with_untracked(|held| *held == value) {
        signal.set(value);
    }
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
    ///
    /// A list mostly changes at one place (a row's item, a row added at the
    /// end), so the rows are first passed in order, each kept while the key
    /// in its place is its own: no map, and nothing written for a row whose
    /// item is equal. Only from the first place whose key is another are
    /// the rows left looked up by key.
    fn update(&self, items: Vec<T>) -> Vec<RegionElement> {
        let mut old = self.state.take().into_iter();
        let mut rows = Vec::with_capacity(items.len());
        let mut out = Vec::with_capacity(items.len());
        let mut items = items.into_iter().enumerate();
        // The first item that is not the row in its place, with its key.
        let mut first = None;
        // With a key twice among the rows, a map of them all decides which
        // row of that key stays, as it always did.
        let mut by_key = !self.distinct.get();
        if !by_key {
            for (index, item) in items.by_ref() {
                let key = (self.key)(&item);
                if old.as_slice().first().is_none_or(|row| row.key != key) {
                    first = Some((index, item, key));
                    by_key = true;
                    break;
                }
                let Some(row) = old.next() else { break };
                // (Its index is its place already.)
                follow(row.item, item);
                keep_row(&mut out, &row.elements);
                rows.push(row);
            }
        }
        // Where the rows made are, as many as are compared with the others.
        let mut made = Vec::new();
        if by_key {
            let mut left: HashMap<K, Row<T, K>> =
                old.by_ref().map(|row| (row.key.clone(), row)).collect();
            let rest = items.map(|(index, item)| {
                let key = (self.key)(&item);
                (index, item, key)
            });
            for (index, item, key) in first.into_iter().chain(rest) {
                // A key twice: the second is a row of its own.
                match left.remove(&key) {
                    Some(row) => {
                        follow(row.item, item);
                        follow(row.index, index);
                        keep_row(&mut out, &row.elements);
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
                        let elements = show_row(&mut out, id, owner, elements);
                        if made.len() <= MADE_COMPARED {
                            made.push(rows.len());
                        }
                        rows.push(Row {
                            key,
                            item,
                            index,
                            owner,
                            elements,
                        });
                    }
                }
            }
            for row in left.into_values() {
                row.owner.dispose();
            }
        }
        // The items ended before the rows did.
        for row in old {
            row.owner.dispose();
        }
        // The rows kept have keys that differ (they were in their places, or
        // came out of the map); a row made may have the key of any other.
        self.distinct.set(
            made.len() <= MADE_COMPARED
                && made.iter().all(|&at| {
                    let key = &rows[at].key;
                    rows.iter()
                        .enumerate()
                        .all(|(other, row)| other == at || row.key != *key)
                }),
        );
        self.state.replace(rows);
        out
    }
}
