//! Components that run once ([`super::Component::view`]): their instance
//! and their [`Scope`].
//!
//! The instance makes the component's view once, under an owner of its
//! own, with its props held in signals: a prop from JS (or a parent's
//! binding) updates what read it. A region that makes the element again
//! makes a new instance, as TSX does. The core mounts
//! the view with its bindings and never asks for it again; releasing the
//! host disposes the owner, and with it everything the component made.

use std::{any::Any, marker::PhantomData, rc::Rc};

use super::{
    AnyValue, Component, Event, IntoElement, JsResult, MethodCall, Owner, PropError, Props,
    builder::{AnyEvent, ElNode},
};
use crate::NodeId;

/// What a component that runs once has of its own: it emits its events
/// (TS: calling an `on…` prop). `Copy`: closures capture it as it is.
pub struct Scope<E> {
    host: NodeId,
    _event: PhantomData<fn(E)>,
}

impl<E> Clone for Scope<E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<E> Copy for Scope<E> {}

impl<E> std::fmt::Debug for Scope<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Scope({})", self.host)
    }
}

impl<E: Event> Scope<E> {
    /// Sends `event` to the app (its `on<Event>` handler), or to the
    /// component whose view has this one.
    pub fn emit(&self, event: E) {
        super::reactive::emit(self.host, Box::new(event));
    }

    /// A listener that forwards this fixed event to the component's listeners.
    pub fn forward(&self, event: E) -> super::Listener<()> {
        super::Listener::<()>::forward(self.host, Rc::new(event))
    }

    /// Makes `api` what the component's ref does in JS (its methods) for as
    /// long as the view lives; the component names it in its spec
    /// (`#[component(methods = StepperApi)]`).
    pub fn methods(&self, api: impl super::Api) {
        super::reactive::register_api(self.host, api);
    }

    /// The edges system UI or a header covers where the component is: its
    /// screen's (below the header) or modal's, else the safe area (TS:
    /// `safeAreaInsets()`). Reading subscribes.
    pub fn insets(&self) -> crate::EdgeInsets {
        super::ambient::insets_of(self.host)
    }
}

/// The instance of a component that runs once.
pub(crate) struct OnceInstance<C: Component> {
    /// The props: as set before the view is made, held afterwards.
    props: C::Props,
    /// What owns the props' own signals, made with the instance: they hold
    /// the values JS and parents give for as long as the instance lives.
    initial: Option<Owner>,
    /// The component's owner, once its view is made.
    owner: Option<Owner>,
    /// Where it was made (its context comes from there).
    parent: Owner,
    host: NodeId,
    _component: PhantomData<fn() -> C>,
}

impl<C: Component> OnceInstance<C> {
    pub(crate) fn new() -> Self {
        let (initial, props) = super::create_root(C::Props::initial);
        Self {
            props,
            initial: Some(initial),
            owner: None,
            parent: Owner::detached(),
            host: 0,
            _component: PhantomData,
        }
    }
}

impl<C: Component> super::component::AnyInstance for OnceInstance<C> {
    fn set_prop(&mut self, name: &str, value: Option<AnyValue>) -> Result<bool, PropError> {
        match self.initial {
            Some(initial) => initial.run(|| self.props.set(name, value)),
            None => self.props.set(name, value),
        }
    }

    fn set_props(&mut self, props: &dyn Any) {
        match props.downcast_ref::<C::Props>() {
            // Before the view: the props it starts with, values in its own
            // signals.
            Some(p) if self.owner.is_none() => {
                let props = &mut self.props;
                match self.initial {
                    Some(initial) => initial.run(|| props.update_from(p)),
                    None => props.update_from(p),
                };
            }
            // After: a new element is a new instance (the core never
            // matches one with an old one).
            Some(_) => log::error!(
                target: "js",
                "{}: props given after its view was made",
                super::component::name_of::<C>()
            ),
            None => {}
        }
    }

    fn set_slot(&mut self, name: &'static str, filled: bool) {
        self.props
            .set_slot(name, filled.then(|| super::Slot::new(name)));
    }

    fn set_children(&mut self, present: bool) {
        self.props.set_children(super::Children::new(present));
    }

    fn cleanup(&mut self) {
        for owner in [self.owner.take(), self.initial.take()]
            .into_iter()
            .flatten()
        {
            owner.dispose();
        }
    }

    fn view(&mut self) -> ElNode {
        if self.owner.is_some() {
            log::error!(target: "js", "a component's view was asked for again");
            return ElNode::empty_view();
        }
        let scope = Scope {
            host: self.host,
            _event: PhantomData,
        };
        let props = &mut self.props;
        let (owner, node) = self.parent.run(|| {
            super::create_root(|| {
                let held = props.held();
                *props = held.clone();
                C::view(held, scope).into_element().0
            })
        });
        self.owner = Some(owner);
        node
    }

    fn name(&self) -> &'static str {
        super::component::name_of::<C>()
    }

    fn call(&mut self, call: MethodCall) -> Option<JsResult> {
        super::reactive::call_api(self.host, call)
    }

    fn owner(&self) -> Option<Owner> {
        self.owner
    }

    fn failure_owner(&self) -> Owner {
        self.owner.unwrap_or(self.parent)
    }

    fn adopt(&mut self, parent: Owner) {
        if self.owner.is_some() || !parent.is_live() {
            return;
        }
        // Preserve a caller's more specific scope (including error boundaries)
        // when it is already under the placement owner. Otherwise the child
        // belongs under the provider where its receiving component placed it.
        let mut at = Some(self.parent);
        while let Some(owner) = at {
            if owner == parent {
                return;
            }
            at = owner.parent();
        }
        self.parent = parent;
    }

    fn place(&mut self, host: NodeId, parent: Owner) {
        self.host = host;
        self.parent = parent;
    }
}

/// An event a component that runs once emitted, for the core.
pub(crate) type Emitted = (NodeId, Box<dyn AnyEvent>);
