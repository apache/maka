//! The iterators of the classes' pair lists (`URLSearchParams`, `Headers`,
//! `FormData`): over a snapshot of the items, inheriting from
//! `%IteratorPrototype%` (so they have `map`, `toArray`, ...).

use super::{
    Class, Key, Object, Spec, data, instance,
    js::{self, Ctx, R, V, native, trace},
};

/// What an iterator over pairs yields.
#[derive(Clone, Copy)]
pub(crate) enum Part {
    Entries,
    Keys,
    Values,
}

struct ListIterator {
    items: std::collections::VecDeque<V>,
}

trace!(ListIterator { items });

impl Object for ListIterator {}

/// An iterator yielding `items`.
pub(crate) fn new(cx: Ctx, items: Vec<V>) -> R<V> {
    instance(
        cx,
        js::UNDEFINED,
        Class::Iterator,
        ListIterator {
            items: items.into(),
        },
    )
}

/// One item of an iterator over string pairs.
pub(crate) fn pair_item(cx: Ctx, k: &str, v: &str, part: Part) -> R<V> {
    pair_value(cx, k, js::string(cx, v)?, part)
}

/// One item of an iterator over pairs with value `v`.
pub(crate) fn pair_value(cx: Ctx, k: &str, v: V, part: Part) -> R<V> {
    match part {
        Part::Keys => js::string(cx, k),
        Part::Values => Ok(v),
        Part::Entries => js::new_array(cx, vec![js::string(cx, k)?, v]),
    }
}

native!(
    fn next(cx, this, args) {
        let item = data::<ListIterator>(cx, this, "Iterator")?.items.pop_front();
        match item {
            Some(v) => js::iter_result(cx, v, false),
            None => js::iter_result(cx, V::undefined(), true),
        }
    }
);

pub(crate) const SPECS: &[Spec] = &[Spec {
    class: Class::Iterator,
    name: c"Iterator",
    parent: None,
    constructor: None,
    methods: &[(Key::Name(c"next"), next, 0)],
    accessors: &[],
    statics: &[],
    constants: &[],
    global: false,
    ts: crate::web::ClassTs::NONE,
}];
