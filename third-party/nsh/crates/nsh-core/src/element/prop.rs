//! A component's prop as the component reads it ([`Prop`]): a `Copy` handle
//! of a value or a binding in the reactive graph.

use std::{fmt, marker::PhantomData, rc::Rc};

use super::{IntoReactive, Memo, Reactive, ReadSignal, Signal, computed, reactive::Node, signal};

/// A prop of a component that runs once (a field of its `#[derive(Props)]`
/// struct): read it in a binding, `props.max.get()`, and the binding runs
/// again when it changes. `Copy`, like a signal: closures capture it as it
/// is.
///
/// A Rust parent passes a value, a signal, a memo or a closure (`.into()`,
/// [`Prop::bind`]); JS passes values, one prop at a time. In the
/// component's instance each prop is a signal of its own, so a new value
/// from JS (or a parent's binding) reaches only what read it.
pub struct Prop<T: 'static> {
    node: Node,
    origin: Origin,
    _t: PhantomData<fn() -> T>,
}

/// What a prop's node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// A signal made for the value it was given: a parent's region making
    /// the element again passes the value on, not the node.
    Value,
    /// A signal, memo or binding of the parent's, read as it is.
    Bound,
    /// An instance's: a signal of its own (which follows the binding a
    /// parent passed, if one did).
    Held,
}

impl<T> Clone for Prop<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Prop<T> {}

/// The same node.
impl<T> PartialEq for Prop<T> {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node
    }
}

impl<T> fmt::Debug for Prop<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Prop({:?})", self.node)
    }
}

impl<T: Clone + PartialEq + Default + 'static> Default for Prop<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

impl<T: Clone + PartialEq + 'static> From<T> for Prop<T> {
    fn from(value: T) -> Self {
        Self::new(value)
    }
}

impl From<&'static str> for Prop<super::SharedString> {
    fn from(value: &'static str) -> Self {
        Self::new(value.into())
    }
}

impl From<String> for Prop<super::SharedString> {
    fn from(value: String) -> Self {
        Self::new(value.into())
    }
}

/// An optional text given as text (`label: "Name".into()`).
impl From<&'static str> for Prop<Option<super::SharedString>> {
    fn from(value: &'static str) -> Self {
        Self::new(Some(value.into()))
    }
}

impl From<String> for Prop<Option<super::SharedString>> {
    fn from(value: String) -> Self {
        Self::new(Some(value.into()))
    }
}

impl From<super::SharedString> for Prop<Option<super::SharedString>> {
    fn from(value: super::SharedString) -> Self {
        Self::new(Some(value))
    }
}

macro_rules! from_handles {
    ($($handle:ident),*) => {$(
        impl<T: Clone + PartialEq + 'static> From<$handle<T>> for Prop<T> {
            fn from(value: $handle<T>) -> Self {
                Self::of(value.node(), Origin::Bound)
            }
        }
    )*};
}

from_handles!(Signal, ReadSignal, Memo);

impl<T: Clone + PartialEq + 'static> From<Reactive<T>> for Prop<T> {
    fn from(value: Reactive<T>) -> Self {
        match value {
            Reactive::Static(v) => Self::new(v),
            Reactive::Bound(f) => Self::bind(move || f()),
        }
    }
}

impl<T: Clone + PartialEq + 'static> Prop<T> {
    /// A prop given `value` (a signal of the current owner).
    pub fn new(value: T) -> Self {
        Self::of(signal(value).node(), Origin::Value)
    }

    /// A prop bound to `f` (a memo of the current owner): run again when
    /// what it reads changes.
    pub fn bind(f: impl Fn() -> T + 'static) -> Self {
        Self::of(computed(f).node(), Origin::Bound)
    }

    fn of(node: Node, origin: Origin) -> Self {
        Self {
            node,
            origin,
            _t: PhantomData,
        }
    }

    /// The value, subscribing the running computation.
    #[track_caller]
    pub fn get(&self) -> T {
        self.with(T::clone)
    }

    /// `f` of the value, subscribing the running computation.
    #[track_caller]
    pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        self.node.with::<T, R>("a prop", f)
    }

    /// The value, without subscribing.
    #[track_caller]
    pub fn get_untracked(&self) -> T {
        super::untracked(|| self.get())
    }

    /// `f` of the value, without subscribing.
    #[track_caller]
    pub fn with_untracked<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        super::untracked(|| self.with(f))
    }

    /// The prop of an instance, made when its view is: a value it was given
    /// stays in the signal it was made with (the instance's props are made
    /// under an owner that lives as long as the instance); a parent's
    /// binding is followed by a signal of the instance's own, which a
    /// computation of the current owner (the instance's) writes.
    #[doc(hidden)]
    pub fn __hold(&self) -> Self {
        match self.origin {
            Origin::Held => *self,
            Origin::Value => Self::of(self.node, Origin::Held),
            Origin::Bound => {
                let binding = *self;
                let node = signal(binding.get_untracked()).node();
                super::reactive::render_effect(move || node.set::<T>(binding.get()));
                Self::of(node, Origin::Held)
            }
        }
    }

    /// Takes `value`: a signal of the prop's own (made for a value, or an
    /// instance's) takes a static value, updating what read it; otherwise
    /// the prop becomes the new one (an instance's, before its view is
    /// made). Whether it changed.
    #[doc(hidden)]
    pub fn __set(&mut self, value: Reactive<T>) -> bool {
        match (self.origin, value) {
            (Origin::Value | Origin::Held, Reactive::Static(v)) => {
                // An equal value is no change: nothing is written (the
                // prop's signal would compare it again and notify no one).
                let changed = self.with_untracked(|old| *old != v);
                if changed {
                    self.node.set::<T>(v);
                }
                changed
            }
            (Origin::Held, Reactive::Bound(_)) => {
                log::error!(
                    target: "js",
                    "a component's prop takes a binding only when its element is made"
                );
                false
            }
            (_, value) => {
                *self = Self::from(value);
                true
            }
        }
    }

    /// An instance's prop, before its view is made, takes what `new` gives:
    /// its value when it was given a value, else its binding.
    #[doc(hidden)]
    pub fn __update_from(&mut self, new: &Self) -> bool {
        if new.origin == Origin::Value {
            return self.__set(Reactive::Static(new.get_untracked()));
        }
        if self == new {
            return false;
        }
        *self = *new;
        true
    }
}

/// The app's children placed here, all at one place (`.child(props.children)`).
impl super::IntoElement for Prop<super::Children> {
    fn into_element(self) -> super::AnyElement {
        self.get_untracked().into_element()
    }
}

/// The app's children, to wrap one by one (`.children_each(props.children, ..)`).
impl From<Prop<super::Children>> for super::Children {
    fn from(children: Prop<super::Children>) -> Self {
        children.get_untracked()
    }
}

impl Prop<Option<super::Slot>> {
    /// The slot where the app fills it, styled by `style`: it comes and
    /// goes as the app fills and empties it.
    pub fn place(
        self,
        style: impl Fn(super::SlotElement) -> super::SlotElement + 'static,
    ) -> super::AnyElement {
        super::dynamic(move || self.get().map(|slot| style(slot.element())))
    }
}

/// A prop passed on, to an element's setter or a child's prop: bound to it
/// (`text(props.title)`).
impl<T: Clone + PartialEq + 'static> IntoReactive<T> for Prop<T> {
    fn into_reactive(self) -> Reactive<T> {
        Reactive::Bound(Rc::new(move || self.get()))
    }
}

/// What a component's prop setter takes (`button().disabled(..)`): a value
/// of a type that becomes a `T` (set once; a `T` for an `Option<T>`, and a
/// string for an optional text), a [`Signal`], [`Memo`],
/// [`ReadSignal`], [`Prop`] or [`Reactive`] of `T`, or a closure returning
/// what becomes a `T` (bound: run again when what it reads changes). `M`
/// tells them apart: it is inferred, never written.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not a prop of `{T}`",
    label = "not a prop of `{T}`",
    note = "a prop is a value that becomes a `{T}`, a signal, memo or prop of it, or a closure `move || ..` returning one"
)]
pub trait IntoProp<T, M> {
    /// As a value or a binding.
    fn into_prop(self) -> Reactive<T>;
}

/// How a value is a prop ([`IntoProp`]).
#[doc(hidden)]
pub struct PropValue(());

/// How a closure is a prop ([`IntoProp`]).
#[doc(hidden)]
pub struct PropClosure(());

/// How a reactive handle is a prop ([`IntoProp`]).
#[doc(hidden)]
pub struct PropHandle(());

/// How a string is an optional text prop ([`IntoProp`]).
#[doc(hidden)]
pub struct PropText(());

/// A string as a set text prop (`.accessibility_label("Save")`).
impl IntoProp<Option<super::SharedString>, PropText> for &'static str {
    fn into_prop(self) -> Reactive<Option<super::SharedString>> {
        Reactive::Static(Some(self.into()))
    }
}

/// A string as a set text prop.
impl IntoProp<Option<super::SharedString>, PropText> for String {
    fn into_prop(self) -> Reactive<Option<super::SharedString>> {
        Reactive::Static(Some(self.into()))
    }
}

impl<T, U: Into<T>> IntoProp<T, PropValue> for U {
    fn into_prop(self) -> Reactive<T> {
        Reactive::Static(self.into())
    }
}

impl<T: 'static, U: Into<T>, F: Fn() -> U + 'static> IntoProp<T, PropClosure> for F {
    fn into_prop(self) -> Reactive<T> {
        Reactive::Bound(Rc::new(move || self().into()))
    }
}

macro_rules! prop_handles {
    ($($handle:ident),*) => {$(
        impl<T: Clone + PartialEq + 'static> IntoProp<T, PropHandle> for $handle<T> {
            fn into_prop(self) -> Reactive<T> {
                self.into_reactive()
            }
        }
    )*};
}

prop_handles!(Signal, ReadSignal, Memo, Prop);

impl<T> IntoProp<T, PropHandle> for Reactive<T> {
    fn into_prop(self) -> Reactive<T> {
        self
    }
}
