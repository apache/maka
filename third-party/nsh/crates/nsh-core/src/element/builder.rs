//! The elements a view is made of ([`view`], [`text`], [`image`], other
//! components, slots and children).

use std::{any::Any, fmt, marker::PhantomData, rc::Rc, sync::Arc};

use super::{
    Component, ComponentSpec, Event, IntoReactive, JsValue, PropError, Reactive, SharedString,
    component::AnyInstance,
    events::{self, GestureEvent, PanEvent},
    style::{StyleRefinement, Styled, Variant},
};
use crate::{
    AccessibilityProp, AccessibilityRole, AccessibilityState, AccessibilityValue, Bounds,
    ContextMenuEvent, EdgeInsets, EventKind, EventPayload, Hsla, ImageSource, ListContentStyle,
    MouseEvent, NativeProp, NodeId, PointerEvents, Points, Prop, Size, Tag, TouchEvent,
    geometry::{DevicePixels, Radians},
    style::Color,
};

/// A handler of `E` on an element: a closure (`move |e: &E| ..`) that
/// writes the signals it captured. It runs under the owner current when it
/// was made (the component, the run of a region or the row whose view made
/// it), so what it makes (signals, animated values, element refs, tasks) is
/// that owner's and goes with it; once that owner is disposed it no longer
/// runs, not even for an event already queued for its node.
pub struct Listener<E: ?Sized> {
    f: Rc<dyn Fn(&E)>,
    owner: super::Owner,
}

impl<E: ?Sized + 'static> Listener<E> {
    /// A listener that does nothing (the element still listens).
    pub(crate) fn noop() -> Self {
        Self::new(Rc::new(|_| {}))
    }

    fn new(f: Rc<dyn Fn(&E)>) -> Self {
        Self {
            f,
            owner: super::Owner::current_or_detached(),
        }
    }

    pub(super) fn forward(host: NodeId, event: Rc<dyn AnyEvent>) -> Listener<()> {
        let name = event.name();
        Listener::new(Rc::new(move |_: &()| {
            super::reactive::emit(
                host,
                Box::new(SharedEvent {
                    event: event.clone(),
                    name,
                }),
            );
        }))
    }

    /// Whether both listeners belong to the same region run or component.
    pub(crate) fn same_owner(&self, other: &Self) -> bool {
        self.owner == other.owner
    }

    /// Whether this is the same installed callback (including its owner).
    pub(crate) fn ptr_eq(&self, other: &Self) -> bool {
        self.same_owner(other) && Rc::ptr_eq(&self.f, &other.f)
    }

    /// Calls it with `event`, under its owner; not once that owner is
    /// disposed: the view it was made for is gone.
    pub(crate) fn call(&self, event: &E) {
        if self.owner == super::Owner::detached() {
            (self.f)(event);
        } else if self.owner.is_live() {
            self.owner.scope(|| (self.f)(event));
        }
    }

    /// A listener of `F` that runs `f` with this one's closure, under its
    /// owner.
    pub(crate) fn wrap<F: ?Sized>(self, f: impl Fn(&dyn Fn(&E), &F) + 'static) -> Listener<F> {
        let inner = self.f;
        Listener {
            f: Rc::new(move |event: &F| f(&*inner, event)),
            owner: self.owner,
        }
    }
}

impl<E: 'static> Listener<E> {
    /// This listener for events of another type, turned into `E` by `f`.
    pub fn map<F: ?Sized + 'static>(self, f: impl Fn(&F) -> E + 'static) -> Listener<F> {
        self.wrap(move |inner, event: &F| inner(&f(event)))
    }
}

/// A closure as a listener.
impl<E: ?Sized + 'static, F: Fn(&E) + 'static> From<F> for Listener<E> {
    fn from(f: F) -> Self {
        Self::new(Rc::new(f))
    }
}

/// What a listener method takes (`on_press`, `on_change`,
/// `on_event`, ...): a closure of the event, `move |text: &str| ..`; for an
/// event without data also one without arguments, `move || ..` (or
/// `move |_: &()| ..`); or a [`Listener`]. `M` tells them apart: it is
/// inferred, never written. (One conversion could not take both closures:
/// a type may implement `Fn()` and `Fn(&())`.)
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not a listener of `{E}`",
    label = "not a listener of `{E}`",
    note = "a listener is a closure `move |event: &{E}| ..` (`move || ..` for an event without data) or a `Listener<{E}>`"
)]
pub trait IntoListener<E: ?Sized, M> {
    /// As the listener.
    fn into_listener(self) -> Listener<E>;
}

/// How a closure of the event is a listener ([`IntoListener`]).
#[doc(hidden)]
pub struct OfEvent(());

/// How a closure without arguments is a listener of an event without data
/// ([`IntoListener`]).
#[doc(hidden)]
pub struct WithoutEvent(());

impl<E: ?Sized> IntoListener<E, ()> for Listener<E> {
    fn into_listener(self) -> Listener<E> {
        self
    }
}

impl<E: ?Sized + 'static, F: Fn(&E) + 'static> IntoListener<E, OfEvent> for F {
    fn into_listener(self) -> Listener<E> {
        Listener::new(Rc::new(self))
    }
}

impl<F: Fn() + 'static> IntoListener<(), WithoutEvent> for F {
    fn into_listener(self) -> Listener<()> {
        Listener::new(Rc::new(move |_: &()| self()))
    }
}

impl<E: ?Sized> Clone for Listener<E> {
    fn clone(&self) -> Self {
        Self {
            f: self.f.clone(),
            owner: self.owner,
        }
    }
}

/// An event a component emitted, with its type erased: what JS hears of
/// it and the event, for Rust listeners.
pub(crate) trait AnyEvent: super::EventToJs {
    fn as_any(&self) -> &dyn Any;
}

impl<E: Event> super::EventToJs for E {
    fn name(&self) -> &'static str {
        Event::name(self)
    }

    fn data_js<'a>(&self, host: &'a dyn super::JsHost) -> Result<super::JsOwned<'a>, PropError> {
        Event::data_js(self, host)
    }
}

impl<E: Event> AnyEvent for E {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A closed forwarder shares the original event without invoking its `Clone`.
struct SharedEvent {
    event: Rc<dyn AnyEvent>,
    name: &'static str,
}

impl super::EventToJs for SharedEvent {
    fn name(&self) -> &'static str {
        self.name
    }

    fn data_js<'a>(&self, host: &'a dyn super::JsHost) -> Result<super::JsOwned<'a>, PropError> {
        self.event.data_js(host)
    }
}

impl AnyEvent for SharedEvent {
    fn as_any(&self) -> &dyn Any {
        // Select the event's method, not `AnyProps` on the `Rc` wrapper.
        self.event.as_ref().as_any()
    }
}

/// The props of an element the core diffs field by field (opaque).
#[doc(hidden)]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attrs {
    pub(crate) disabled: bool,
    pub(crate) accessible: Option<bool>,
    pub(crate) label: Option<SharedString>,
    pub(crate) hint: Option<SharedString>,
    pub(crate) role: AccessibilityRole,
    pub(crate) state: AccessibilityState,
    pub(crate) value: Option<AccessibilityValue>,
    /// The core's own (a tooltip's hint); apps' are the style's.
    pub(crate) pointer_events: PointerEvents,
    pub(crate) src: Option<super::ImageSrc>,
    pub(crate) inset_padding: Option<EdgeInsets>,
    pub(crate) inset_margin: Option<EdgeInsets>,
    /// An inline style (a `Style` prop), over the styles.
    pub(crate) inline: Option<std::rc::Rc<crate::StylePatch>>,
    /// The props of host elements (inputs, scroll views, ...), one per
    /// property ([`super::host`]).
    pub(crate) props: Vec<Prop>,
    /// A canvas's drawing.
    pub(crate) drawing: Option<Arc<crate::canvas::Drawing>>,
    /// What the ref the view put on the element names (not a prop): held
    /// while the element is, however long the ref's owner lives.
    pub(crate) element_ref: Option<super::element_ref::RefTarget>,
    /// Style properties bound to native animation nodes (held while
    /// bound).
    pub(crate) animated: Vec<(crate::StyleDecl, super::LiveNode)>,
    /// Animated nodes host props read (drags, scroll offsets), held.
    pub(crate) bound: Vec<super::LiveNode>,
    /// Tailwind classes the app gave through a prop (a component's part),
    /// after the element's own styles.
    pub(crate) class: Option<SharedString>,
    /// The view is a selectable view ([`crate::selection`]).
    pub(crate) selectable_view: bool,
    /// The states it shows as its control's part
    /// ([`Interactive::project_checked`]).
    pub(crate) projected_states: u16,
    /// Where a JS renderer's content goes (the element is its
    /// placeholder: [`super::Renderer::render`]).
    pub(crate) render: Option<super::renderer::RenderAt>,
}

impl Attrs {
    /// The props of the fields that differ from `old`, in a fixed order.
    pub(crate) fn changes(&self, old: &Attrs, out: &mut Vec<Prop>) {
        use AccessibilityProp as A;
        if self.disabled != old.disabled {
            out.push(Prop::Native(NativeProp::Disabled(self.disabled)));
        }
        if self.accessible != old.accessible {
            out.push(Prop::Accessibility(A::Accessible(self.accessible)));
        }
        if self.label != old.label {
            out.push(Prop::Accessibility(A::Label(
                self.label.as_ref().map(SharedString::to_arc),
            )));
        }
        if self.hint != old.hint {
            out.push(Prop::Accessibility(A::Hint(
                self.hint.as_ref().map(SharedString::to_arc),
            )));
        }
        if self.role != old.role {
            out.push(Prop::Accessibility(A::Role(self.role)));
        }
        if self.state != old.state {
            out.push(Prop::Accessibility(A::State(self.state)));
        }
        if self.value != old.value {
            out.push(Prop::Accessibility(A::Value(self.value.clone())));
        }
        if self.pointer_events != old.pointer_events {
            out.push(Prop::PointerEvents(self.pointer_events));
        }
        if self.src != old.src {
            out.push(Prop::Source(self.src.as_ref().map(|src| ImageSource {
                uri: src.uri.to_arc(),
                size: src.size.map(|(w, h)| crate::geometry::size_pt(w, h)),
                scales: src.scales,
                data: None,
            })));
        }
        if self.inset_padding != old.inset_padding {
            out.push(Prop::InsetPadding(self.inset_padding.unwrap_or_default()));
        }
        if self.inset_margin != old.inset_margin {
            out.push(Prop::InsetMargin(self.inset_margin.unwrap_or_default()));
        }
        if self.selectable_view != old.selectable_view {
            out.push(Prop::SelectableView(self.selectable_view));
        }
        if self.projected_states != old.projected_states {
            out.push(Prop::ProjectedStates(self.projected_states));
        }
        // Host props: the ones no longer set go back to their defaults,
        // then the new and changed ones.
        for prop in &old.props {
            if !self.props.iter().any(|p| super::host::same_kind(p, prop))
                && let Some(reset) = super::host::reset(prop)
            {
                out.push(reset);
            }
        }
        for prop in &self.props {
            if !old.props.contains(prop) {
                out.push(prop.clone());
            }
        }
    }
}

/// A nested component's props, with their type erased.
pub(crate) trait AnyProps {
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
    fn clone_box(&self) -> Box<dyn AnyProps>;
}

impl<P: Clone + 'static> AnyProps for P {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn clone_box(&self) -> Box<dyn AnyProps> {
        Box::new(self.clone())
    }
}

/// A nested component of a view.
pub(crate) struct ComponentEl {
    pub(crate) name: &'static str,
    /// Makes an instance: a component a view makes need not be registered
    /// (the registry is what JS can make by name).
    pub(crate) make: fn() -> Box<dyn AnyInstance>,
    /// Its spec (made once per type and kept by the core).
    pub(crate) spec: fn() -> ComponentSpec,
    pub(crate) props: Box<dyn AnyProps>,
    /// The handlers of its events in the view that has it, in order.
    pub(crate) on_event: Vec<Listener<dyn Any>>,
}

impl Clone for ComponentEl {
    fn clone(&self) -> Self {
        Self {
            name: self.name,
            make: self.make,
            spec: self.spec,
            props: self.props.clone_box(),
            on_event: self.on_event.clone(),
        }
    }
}

/// Places one piece of the app's content: a JSX child, or a list row.
pub(crate) type PlaceFn = Rc<dyn Fn(Child, Position) -> AnyElement>;

/// Where a JSX child or a list row is among its siblings (what a TS row
/// knows from its index and the data's length). `Copy`: a handle of two
/// signals, so a binding that reads it (`move || at.is_last()`) runs again
/// when a list cell shows another row or the rows come and go, and the
/// cell's content stays.
#[derive(Clone, Copy)]
pub struct Position {
    index: super::reactive::Node,
    count: super::reactive::Node,
}

impl Position {
    /// The position read from signals (or memos) of the index and the
    /// count.
    pub(crate) fn of(index: super::reactive::Node, count: super::reactive::Node) -> Self {
        Self { index, count }
    }

    /// A position that does not change (signals of the current owner).
    pub(crate) fn fixed(index: usize, count: usize) -> Self {
        Self::of(super::signal(index).node(), super::signal(count).node())
    }

    /// Its index, subscribing the running computation.
    #[track_caller]
    pub fn index(&self) -> usize {
        self.index.with("a position", |i: &usize| *i)
    }

    /// How many there are, subscribing the running computation.
    #[track_caller]
    pub fn count(&self) -> usize {
        self.count.with("a position", |n: &usize| *n)
    }

    /// The first one.
    #[track_caller]
    pub fn is_first(&self) -> bool {
        self.index() == 0
    }

    /// The last one.
    #[track_caller]
    pub fn is_last(&self) -> bool {
        self.index() + 1 == self.count()
    }
}

impl fmt::Debug for Position {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (index, count) = super::untracked(|| (self.index(), self.count()));
        write!(f, "Position({index} of {count})")
    }
}

/// How a list is laid out (each set field is sent to the list); set with
/// [`super::ListLayout`]'s methods.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ListConfig {
    pub(crate) estimated: Option<f32>,
    pub(crate) columns: Option<u32>,
    pub(crate) horizontal: Option<bool>,
    pub(crate) inverted: Option<bool>,
    pub(crate) scrollbar_visible: Option<bool>,
    pub(crate) content: Option<ListContentStyle>,
    pub(crate) follow_end: Option<f32>,
    pub(crate) viewport: Option<crate::ListViewport>,
}

impl ListConfig {
    /// The props of the fields that differ from `old`.
    pub(crate) fn changes(&self, old: &ListConfig, out: &mut Vec<Prop>) {
        if self.estimated != old.estimated {
            out.push(Prop::EstimatedItemSize(Points(
                self.estimated.unwrap_or(50.0),
            )));
        }
        if self.columns != old.columns {
            out.push(Prop::Columns(self.columns.unwrap_or(1)));
        }
        if self.horizontal != old.horizontal {
            out.push(Prop::Horizontal(self.horizontal.unwrap_or(false)));
        }
        if self.inverted != old.inverted {
            out.push(Prop::Inverted(self.inverted.unwrap_or(false)));
        }
        if self.scrollbar_visible != old.scrollbar_visible {
            out.push(Prop::Scrollbar(
                self.scrollbar_visible.unwrap_or(true).into(),
            ));
        }
        if self.content != old.content {
            out.push(Prop::ListContent(self.content.unwrap_or_default()));
        }
        if self.follow_end != old.follow_end {
            out.push(Prop::FollowEnd(self.follow_end.map(Points)));
        }
        if self.viewport != old.viewport {
            out.push(Prop::ListViewport(self.viewport.unwrap_or_default()));
        }
    }
}

/// A list slot as a view places it.
#[derive(Clone)]
pub(crate) struct ListEl {
    pub(crate) name: &'static str,
    pub(crate) config: ListConfig,
    pub(crate) row: PlaceFn,
}

/// What an element is beyond its tag.
#[derive(Clone)]
pub(crate) enum ElKind {
    Plain,
    /// Where slot `name` goes (a view placing it).
    Slot(&'static str),
    /// What a view fills a nested component's slot `name` with: its
    /// children, placed as they are where the nested view places the slot.
    Fill(&'static str),
    /// Where the nested view places what a view filled slot `name` with
    /// (no node of its own).
    Filled(&'static str),
    /// Where the JSX children go (a list row's content, in a row).
    Children,
    /// One JSX child (in [`ParentElement::children_each`]).
    JsChild(NodeId),
    /// Every JSX child, each placed by the function.
    EachChild(PlaceFn),
    /// The glue's list of an [`Items`] prop.
    List(Box<ListEl>),
    /// A list of the component's own rows ([`super::virtual_list`]).
    VirtualList(Box<super::virtual_list::VirtualListEl>),
    /// A piece of a text's content among its spans (a raw text node, as
    /// JS's strings in a `<text>`).
    Raw,
    Component(ComponentEl),
    /// Elements that change ([`super::dynamic`], [`super::If`],
    /// [`super::Each`]): a region of its parent's children, reconciled on
    /// its own.
    Region(super::flow::Region),
    /// In a region: the element of this key stays as it is (an `Each` row
    /// that was there before).
    Keep,
}

/// An element as the core expands it (opaque).
#[doc(hidden)]
#[derive(Clone)]
pub struct ElNode {
    pub(crate) tag: Tag,
    pub(crate) key: Option<SharedString>,
    /// A text's content.
    pub(crate) text: Option<SharedString>,
    pub(crate) attrs: Attrs,
    pub(crate) style: StyleRefinement,
    pub(crate) handlers: Vec<(EventKind, Listener<EventPayload>)>,
    /// Its part in the touch responder's negotiation.
    pub(crate) responder: Option<Rc<super::responder::ResponderEl>>,
    pub(crate) children: Vec<ElNode>,
    pub(crate) kind: ElKind,
    /// A text's content when it is bound (read in a binding).
    pub(crate) bound_text: Option<Rc<dyn Fn() -> SharedString>>,
    /// Bound props: each sets the fields it binds on the static ones.
    pub(crate) bound_attrs: Vec<BoundAttrs>,
    /// A list's bound layout: each sets the fields it binds.
    pub(crate) bound_list: Vec<BoundListConfig>,
}

/// A bound part of a list's layout.
#[doc(hidden)]
pub type BoundListConfig = Rc<dyn Fn(&mut ListConfig)>;

crate::static_reactive!(AccessibilityState: AccessibilityState);
crate::static_reactive!(EdgeInsets: EdgeInsets);
crate::static_reactive!(Style: Style);
crate::static_reactive!(PointerEvents: PointerEvents);

/// A bound part of an element's props.
pub(crate) type BoundAttrs = Rc<dyn Fn(&mut Attrs)>;

impl ElNode {
    /// Applies `value` to the props with `apply`: now when it is static,
    /// else as a bound part.
    pub(crate) fn bind_attr<T: 'static>(
        &mut self,
        value: impl IntoReactive<T>,
        apply: impl Fn(&mut Attrs, T) + 'static,
    ) {
        match value.into_reactive() {
            Reactive::Static(v) => apply(&mut self.attrs, v),
            Reactive::Bound(f) => self.bound_attrs.push(Rc::new(move |a| apply(a, f()))),
        }
    }

    /// Whether it has bound parts (text, props or styles).
    pub(crate) fn is_bound(&self) -> bool {
        self.bound_text.is_some()
            || !self.bound_attrs.is_empty()
            || self.style.is_bound()
            || !self.bound_list.is_empty()
    }

    /// The props now: the static ones with the bound parts applied (read in
    /// the running computation, which subscribes to them).
    pub(crate) fn resolved_attrs(&self) -> Attrs {
        let mut attrs = self.attrs.clone();
        for part in &self.bound_attrs {
            part(&mut attrs);
        }
        attrs
    }

    /// Turns the bound parts into static ones, read once, untracked: how a
    /// nested component's element and a slot's node take them.
    pub(crate) fn resolve_once(&mut self) {
        if !self.is_bound() {
            return;
        }
        super::untracked(|| {
            if let Some(text) = self.bound_text.take() {
                self.text = Some(text());
            }
            if !self.bound_attrs.is_empty() {
                self.attrs = self.resolved_attrs();
                self.bound_attrs.clear();
            }
            if self.style.is_bound() {
                self.style = self.style.resolved();
            }
            let parts = std::mem::take(&mut self.bound_list);
            if let Some(config) = self.list_config() {
                for part in &parts {
                    part(config);
                }
            }
        });
    }

    /// A list's layout (of a list element or a virtual list).
    pub(crate) fn list_config(&mut self) -> Option<&mut ListConfig> {
        match &mut self.kind {
            ElKind::List(list) => Some(&mut list.config),
            ElKind::VirtualList(list) => Some(&mut list.config),
            _ => None,
        }
    }

    /// What a component that is not registered renders.
    pub(crate) fn empty_view() -> Self {
        Self::new(Tag::View)
    }

    pub(crate) fn new(tag: Tag) -> Self {
        Self {
            tag,
            key: None,
            text: None,
            attrs: Attrs::default(),
            style: StyleRefinement::default(),
            handlers: Vec::new(),
            responder: None,
            children: Vec::new(),
            kind: ElKind::Plain,
            bound_text: None,
            bound_attrs: Vec::new(),
            bound_list: Vec::new(),
        }
    }
}

/// Any element, its type erased.
pub struct AnyElement(pub(crate) ElNode);

/// What can be a child: elements, and strings (as texts).
pub trait IntoElement {
    /// As an element.
    fn into_element(self) -> AnyElement;
}

impl IntoElement for AnyElement {
    fn into_element(self) -> AnyElement {
        self
    }
}

impl IntoElement for SharedString {
    fn into_element(self) -> AnyElement {
        text(self).into_element()
    }
}

impl IntoElement for &'static str {
    fn into_element(self) -> AnyElement {
        text(self).into_element()
    }
}

impl IntoElement for String {
    fn into_element(self) -> AnyElement {
        text(self).into_element()
    }
}

/// What `.child(..)` takes ([`ParentElement::child`]): an element, or
/// what holds elements (an `Option`, a `Vec`, an array or an iterator of
/// them: `rows.iter().map(|r| row(r))`). `M` tells the two apart: it is
/// inferred, never written. (One blanket conversion could not take both: a
/// type may be an element and hold elements.)
#[diagnostic::on_unimplemented(
    message = "`{Self}` is not an element",
    label = "not an element",
    note = "elements are host elements (`view()`, `text(..)`, ...), components' elements, strings, and an `Option`, a `Vec`, an array or an iterator of elements"
)]
pub trait IntoChild<M> {
    /// Adds what it is to `out`.
    #[doc(hidden)]
    fn __push_into(self, out: &mut Vec<ElNode>);
}

/// How an element is a child ([`IntoChild`]).
#[doc(hidden)]
pub struct OneChild(());

/// How what holds elements is children ([`IntoChild`]).
#[doc(hidden)]
pub struct ManyChildren(());

impl<T: IntoElement> IntoChild<OneChild> for T {
    fn __push_into(self, out: &mut Vec<ElNode>) {
        out.push(self.into_element().0);
    }
}

impl<I: IntoIterator> IntoChild<ManyChildren> for I
where
    I::Item: IntoElement,
{
    fn __push_into(self, out: &mut Vec<ElNode>) {
        out.extend(self.into_iter().map(|c| c.into_element().0));
    }
}

/// Conditional building, as GPUI's `FluentBuilder` (`gpui::prelude`): decided
/// once, as the element is made. What must follow a signal is a region
/// ([`super::when`], [`super::dynamic`]).
pub trait FluentBuilder: Sized {
    /// `then(self)` when `condition` holds.
    fn when(self, condition: bool, then: impl FnOnce(Self) -> Self) -> Self {
        if condition { then(self) } else { self }
    }

    /// `then(self, value)` when `option` has one.
    fn when_some<T>(self, option: Option<T>, then: impl FnOnce(Self, T) -> Self) -> Self {
        match option {
            Some(v) => then(self, v),
            None => self,
        }
    }

    /// `f(self)`.
    fn map(self, f: impl FnOnce(Self) -> Self) -> Self {
        f(self)
    }
}

impl<T: Element> FluentBuilder for T {}

/// An element: what every element can do. Its other abilities are the
/// traits it implements ([`Styled`], [`Accessible`], [`Interactive`],
/// [`ParentElement`]).
pub trait Element: IntoElement + Sized {
    #[doc(hidden)]
    fn node(&mut self) -> &mut ElNode;

    /// Identifies the element among its siblings when they are made again
    /// (a region's, a list cell's row; where their order changes).
    fn key(mut self, key: impl Into<SharedString>) -> Self {
        self.node().key = Some(key.into());
        self
    }

    /// Binds `opacity` to an animated value (it moves natively).
    fn bind_opacity(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::Opacity, value)
    }

    /// Binds the background color to a node of colors
    /// ([`super::AnimatedNode::interpolate_colors`]).
    fn bind_background(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::BackgroundColor, value)
    }

    /// Binds the color of every border side to a node of colors.
    fn bind_border_color(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::BorderColor, value)
    }

    /// Binds a text's color (the whole text) to a node of colors.
    fn bind_color(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::Color, value)
    }

    /// Binds `prop` (anything but a transform step or a canvas argument)
    /// to an animated value (nothing once the value's owner is gone).
    fn bind(mut self, prop: crate::animation::AnimationProp, value: &impl super::Animated) -> Self {
        if let Some(node) = value.animated_node().live() {
            let decl = crate::StyleDecl::Animated(prop, node.id());
            self.node().attrs.animated.push((decl, node));
        }
        self
    }

    /// A sticky view ([`super::Styled::sticky`]) sticks this animated value
    /// from the top of the scroll view's viewport, following it (below a
    /// header that moves: `header.add(8.0)`; TS: `top` set to an animated
    /// value).
    fn bind_sticky_top(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::StickyTop, value)
    }

    /// The same as [`Self::bind_sticky_top`] in a horizontal scroll view.
    fn bind_sticky_left(self, value: &impl super::Animated) -> Self {
        self.bind(crate::animation::AnimationProp::StickyLeft, value)
    }

    /// Appends a transform step driven by an animated value, after the styles'
    /// transforms.
    fn bind_transform(mut self, kind: crate::TransformKind, value: &impl super::Animated) -> Self {
        if let Some(node) = value.animated_node().live() {
            let decl = crate::StyleDecl::Transform(kind, kind.identity(), Some(node.id()));
            self.node().attrs.animated.push((decl, node));
        }
        self
    }

    /// Binds a motion's channels: its opacity, and its transform after the
    /// styles' transforms (translations, then rotations, then the scales,
    /// `scale` folded into `scale_x` and `scale_y`).
    fn bind_motion(self, motion: &super::Motion) -> Self {
        use crate::animation::MotionChannel::*;
        let mut this = self.bind_opacity(&motion.value(Opacity));
        for channel in [TranslateX, TranslateY, Rotate, RotateX, RotateY] {
            if let Some(kind) = channel.transform() {
                this = this.bind_transform(kind, &motion.value(channel));
            }
        }
        let scale = motion.value(Scale);
        this.bind_transform(
            crate::TransformKind::ScaleX,
            &scale.mul(&motion.value(ScaleX)),
        )
        .bind_transform(
            crate::TransformKind::ScaleY,
            &scale.mul(&motion.value(ScaleY)),
        )
    }

    /// Moves it right by an animated value (points).
    fn bind_translate_x(self, value: &impl super::Animated) -> Self {
        self.bind_transform(crate::TransformKind::TranslateX, value)
    }

    /// Moves it down by an animated value (points).
    fn bind_translate_y(self, value: &impl super::Animated) -> Self {
        self.bind_transform(crate::TransformKind::TranslateY, value)
    }

    /// Scales it by an animated value.
    fn bind_scale(self, value: &impl super::Animated) -> Self {
        self.bind_transform(crate::TransformKind::Scale, value)
    }

    /// Rotates it by an animated value (degrees, clockwise).
    fn bind_rotate(self, value: &impl super::Animated) -> Self {
        self.bind_transform(crate::TransformKind::Rotate, value)
    }

    /// Puts `handle` on this element: its commands (`focus`, `scroll_to`)
    /// go here (nothing once the ref's owner is gone).
    fn element_ref(mut self, handle: &super::ElementRef) -> Self {
        self.node().attrs.element_ref = handle.target();
        self
    }

    /// Padding added to the element's own (from styles): insets of system
    /// UI, a keyboard.
    fn inset_padding(mut self, insets: impl IntoReactive<EdgeInsets>) -> Self {
        self.node()
            .bind_attr(insets, |a, insets| a.inset_padding = Some(insets));
        self
    }

    /// Margin added to the element's own.
    fn inset_margin(mut self, insets: impl IntoReactive<EdgeInsets>) -> Self {
        self.node()
            .bind_attr(insets, |a, insets| a.inset_margin = Some(insets));
        self
    }

    /// An inline style the app passed (a prop of type `Style`, React
    /// Native's names), over the element's styles.
    fn inline_style(mut self, style: impl IntoReactive<Style>) -> Self {
        Style::apply(self.node(), style, Variant::default(), |a, patch| {
            a.inline = patch
        });
        self
    }

    /// Makes the texts in the view select together, as a browser page's
    /// do (TSX `<View selectable>`): a selection runs from text to text,
    /// across views and `TextView`s; texts that are not selectable stay
    /// out of it ([`crate::selection`]).
    fn selectable(mut self, area: impl IntoReactive<bool>) -> Self {
        self.node()
            .bind_attr(area, |a, area| a.selectable_view = area);
        self
    }

    /// Tailwind classes the app passed (a prop naming the classes of one
    /// of the component's parts: `classes={{ heading: "text-2xl" }}`),
    /// after the element's own styles, as the app's `class` on a
    /// component's root is: at equal rank they win.
    fn app_class(mut self, class: impl IntoReactive<Option<SharedString>>) -> Self {
        self.node().bind_attr(class, |a, class| a.class = class);
        self
    }
}

/// An inline style: a prop typed `StyleProp<ViewStyle>` in TypeScript (an
/// object, an array of them, or nothing), decoded when JS sets it as a host
/// element's `style` is (transforms, shadow offsets, native animated
/// values included), and applied with [`Element::inline_style`]. Rust
/// makes one with the typed styles (`From<StyleRefinement>`: what a style
/// prop's setter does with its closure, `.selected_style(|s| s.bg(..))`),
/// theme colors following the appearance and bound parts their signals,
/// as in `.active(|s| ..)`; or from declarations ([`Style::from_decls`],
/// [`Style::with`]).
/// Its native animated values are node ids, valid while the style is the
/// prop's current value (JS keeps the values alive with it, as a host
/// element's `style` does); a component that keeps an older `Style`
/// beyond that may hold ids of values JS has collected.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Style(
    pub(crate) Option<std::rc::Rc<crate::StylePatch>>,
    /// The typed styles it was made of (Rust's), applied as the element's
    /// own are.
    pub(crate) StyleRefinement,
);

impl Style {
    /// A style of `decls`, applied in order; one that does not apply (a
    /// value of the wrong type or format) is left out and logged, as on a
    /// host element.
    pub fn from_decls(decls: impl IntoIterator<Item = crate::StyleDecl>) -> Self {
        let mut style = crate::Style::default();
        let mut patch = crate::StylePatch::default();
        for decl in decls {
            let key = match &decl {
                crate::StyleDecl::Set(key, _) => Some(*key),
                _ => None,
            };
            if patch.push(&mut style, decl).is_err()
                && let Some(key) = key
            {
                log::warn!("invalid value for style `{}`", key.name());
            }
        }
        Self(Some(std::rc::Rc::new(patch)), StyleRefinement::default())
    }

    /// This style with property `key` set to `value` after the rest
    /// (`Style::default().with(StyleKey::Opacity, PropertyValue::Number(0.5.into()))`).
    pub fn with(self, key: crate::StyleKey, value: crate::PropertyValue) -> Self {
        let decls = self.0.iter().flat_map(|p| p.decls().iter().cloned());
        let mut style = Self::from_decls(decls.chain([crate::StyleDecl::Set(key, value)]));
        style.1 = self.1;
        style
    }

    /// Its declarations, in order (not its typed styles').
    pub fn decls(&self) -> &[crate::StyleDecl] {
        self.0.as_deref().map_or(&[], crate::StylePatch::decls)
    }

    /// Applies it to `node` in `variant`: the declarations with `attr`, the
    /// typed styles as part of the node's own. A bound style adds its
    /// typed styles as a bound part only when it has some as the element
    /// is made (they are set with the element; JS's styles have none), so
    /// a style prop left unset costs what a style of declarations does.
    pub(crate) fn apply(
        node: &mut ElNode,
        style: impl IntoReactive<Style>,
        variant: Variant,
        attr: impl Fn(&mut Attrs, Option<std::rc::Rc<crate::StylePatch>>) + 'static,
    ) {
        match style.into_reactive() {
            Reactive::Static(Style(patch, typed)) => {
                attr(&mut node.attrs, patch);
                if !typed.is_empty() {
                    node.style.extend_as(variant, typed);
                }
            }
            Reactive::Bound(f) => {
                let typed = super::untracked(|| !f().1.is_empty());
                let patch = f.clone();
                node.bind_attr(move || patch().0, attr);
                if typed {
                    // Resolved here: the bound parts of what it adds would
                    // not run in this resolution.
                    node.style
                        .bind(move |s| s.extend_as(variant, f().1.resolved()));
                }
            }
        }
    }
}

impl From<crate::StylePatch> for Style {
    fn from(patch: crate::StylePatch) -> Self {
        Self(Some(std::rc::Rc::new(patch)), StyleRefinement::default())
    }
}

impl From<StyleRefinement> for Style {
    fn from(style: StyleRefinement) -> Self {
        Self(None, style)
    }
}

impl JsValue for Style {
    fn ts_type(_types: &mut super::TsTypes) -> String {
        "StyleProp<ViewStyle>".into()
    }

    /// Decoded as a host element's `style` is ([`super::JsHost::style`]);
    /// what it does not take is logged, as there.
    fn from_js(value: super::JsIn<'_>) -> Result<Self, PropError> {
        if value.is_nullish() {
            return Ok(Self::default());
        }
        Ok(Self::from(value.host().style(value.raw())?))
    }

    /// A style is JS's to give, not to get back.
    fn to_js<'a>(&self, _host: &'a dyn super::JsHost) -> Result<super::JsOwned<'a>, PropError> {
        Err(PropError("a style does not convert back to JS".to_owned()))
    }
}

/// The style of a component's part that shows text (a select's rows, a
/// one-time code's cells): a [`Style`] whose TypeScript type takes the text
/// styles too (`StyleProp<TextStyle>`: `color`, `fontSize`, `textAlign`),
/// which the part's texts inherit. A part that edits text takes an
/// [`InputPartStyle`]. Its setter takes
/// the typed styles' closure, as a `Style`'s does; the part applies it with
/// [`Element::inline_style`] (it is `Into<Style>`).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct TextPartStyle(pub Style);

impl From<Style> for TextPartStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl From<StyleRefinement> for TextPartStyle {
    fn from(style: StyleRefinement) -> Self {
        Self(Style::from(style))
    }
}

impl From<TextPartStyle> for Style {
    fn from(style: TextPartStyle) -> Self {
        style.0
    }
}

impl JsValue for TextPartStyle {
    fn ts_type(_types: &mut super::TsTypes) -> String {
        "StyleProp<TextStyle>".into()
    }

    fn from_js(value: super::JsIn<'_>) -> Result<Self, PropError> {
        Style::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn super::JsHost) -> Result<super::JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

/// The style of a component's part that edits text (a number input's
/// field, a select's search field): a [`Style`] whose TypeScript type takes
/// the input styles too (`StyleProp<InputStyle>`: the text styles and
/// `placeholderColor`, `caretColor`, `selectionColor`). As
/// [`TextPartStyle`], its setter takes the typed styles' closure.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct InputPartStyle(pub Style);

impl From<Style> for InputPartStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl From<StyleRefinement> for InputPartStyle {
    fn from(style: StyleRefinement) -> Self {
        Self(Style::from(style))
    }
}

impl From<InputPartStyle> for Style {
    fn from(style: InputPartStyle) -> Self {
        style.0
    }
}

impl JsValue for InputPartStyle {
    fn ts_type(_types: &mut super::TsTypes) -> String {
        "StyleProp<InputStyle>".into()
    }

    fn from_js(value: super::JsIn<'_>) -> Result<Self, PropError> {
        Style::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn super::JsHost) -> Result<super::JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

impl<T: Element> Styled for T {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.node().style
    }
}

/// Elements with children.
pub trait ParentElement: Element {
    /// Adds a child: an element, or the elements an `Option`, a `Vec`, an
    /// array or an iterator holds.
    fn child<M>(mut self, child: impl IntoChild<M>) -> Self {
        child.__push_into(&mut self.node().children);
        self
    }

    /// Adds children (an `Option` adds one or none).
    fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
        self.node()
            .children
            .extend(children.into_iter().map(|c| c.into_element().0));
        self
    }

    /// Places slot `slot` here when the app passed it, as `place` styles it
    /// (the closure gets the slot's own node).
    fn slot(mut self, slot: Option<Slot>, place: impl FnOnce(SlotElement) -> SlotElement) -> Self {
        if let Some(slot) = slot {
            let mut node = ElNode::new(Tag::View);
            node.kind = ElKind::Slot(slot.name);
            self.node().children.push(place(SlotElement(node)).0);
        }
        self
    }

    /// Places the app's JSX children here one by one: `place(child, at)`
    /// wraps each (runs again when the children change).
    fn children_each<R: IntoElement>(
        mut self,
        children: impl Into<Children>,
        place: impl Fn(Child, Position) -> R + 'static,
    ) -> Self {
        let _ = children.into();
        let mut node = ElNode::new(Tag::View);
        node.kind = ElKind::EachChild(Rc::new(move |child, at| place(child, at).into_element()));
        self.node().children.push(node);
        self
    }

    /// Places the app's virtualized list of `items` here: `config` lays
    /// the list out (size, columns, padding), `row(content, at)` wraps
    /// each row the app renders, once per cell (`at` follows the row the
    /// cell shows and the number of rows). Only rows near the viewport
    /// exist; the core recycles them.
    fn list<R: IntoElement>(
        mut self,
        items: Items,
        config: impl FnOnce(ListElement) -> ListElement,
        row: impl Fn(Child, Position) -> R + 'static,
    ) -> Self {
        let mut node = ElNode::new(Tag::List);
        node.kind = ElKind::List(Box::new(ListEl {
            name: items.name,
            config: ListConfig::default(),
            row: Rc::new(move |content, at| row(content, at).into_element()),
        }));
        self.node().children.push(config(ListElement(node)).0);
        self
    }
}

/// Elements with an accessibility description.
pub trait Accessible: Element {
    /// Whether assistive technologies see it as one element.
    fn accessible(mut self, accessible: impl IntoReactive<bool>) -> Self {
        self.node()
            .bind_attr(accessible, |a, accessible| a.accessible = Some(accessible));
        self
    }

    /// What screen readers say.
    fn label(mut self, label: impl IntoReactive<SharedString>) -> Self {
        self.node()
            .bind_attr(label, |a, label| a.label = Some(label));
        self
    }

    /// What screen readers say, while it is set (`None`: what its
    /// content says).
    fn optional_label(mut self, label: impl IntoReactive<Option<SharedString>>) -> Self {
        self.node().bind_attr(label, |a, label| a.label = label);
        self
    }

    /// What happens when activated, for screen readers.
    fn hint(mut self, hint: impl IntoReactive<SharedString>) -> Self {
        self.node().bind_attr(hint, |a, hint| a.hint = Some(hint));
        self
    }

    /// What it is (a button, a header, ...).
    fn role(mut self, role: impl IntoReactive<AccessibilityRole>) -> Self {
        self.node().bind_attr(role, |a, role| a.role = role);
        self
    }

    /// Its state for screen readers (`disabled` follows
    /// [`Interactive::disabled`]).
    fn accessibility_state(mut self, state: impl IntoReactive<AccessibilityState>) -> Self {
        self.node().bind_attr(state, |a, state| {
            a.state = AccessibilityState {
                disabled: a.state.disabled,
                ..state
            };
        });
        self
    }

    /// Its value for screen readers, for a range (a progress bar, a
    /// slider: `min`, `max` and `now`) or as a text; `None` has none (an
    /// indeterminate progress bar keeps its range and leaves out `now`).
    fn accessibility_value(mut self, value: impl IntoReactive<Option<AccessibilityValue>>) -> Self {
        self.node().bind_attr(value, |a, value| a.value = value);
        self
    }

    /// Hides it and everything inside it from assistive technologies
    /// while `hidden` holds (TS: `accessibilityElementsHidden`): what a
    /// control shows of a value that another element of it tells screen
    /// readers already (a one-time-code input's cells, whose text field
    /// says the code).
    fn accessibility_elements_hidden(mut self, hidden: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(hidden, |a, hidden| {
            super::host::set_in(
                &mut a.props,
                Prop::Accessibility(AccessibilityProp::Hidden(hidden)),
            )
        });
        self
    }

    /// The actions assistive technologies offer on it (TS:
    /// `accessibilityActions`): `increment` and `decrement` for an
    /// adjustable element, `activate`, `longpress`, or the app's own with
    /// a label; [`Interactive::on_accessibility_action`] hears them.
    fn accessibility_actions(mut self, actions: Vec<crate::AccessibilityActionDef>) -> Self {
        super::host::set(
            self.node(),
            Prop::Accessibility(AccessibilityProp::Actions(actions)),
        );
        self
    }
}

/// What an element's tooltip can be ([`Interactive::tooltip`]): an
/// element, shown as it is (`nsh_base`'s `Tooltip` is the tooltip itself).
pub trait IntoTooltip {
    #[doc(hidden)]
    fn apply_tooltip(self, node: &mut ElNode);
}

impl IntoTooltip for AnyElement {
    fn apply_tooltip(self, node: &mut ElNode) {
        // A hint overlay inside the element, as the core makes for JS's.
        let mut hint = ElNode::new(Tag::Overlay);
        hint.key = Some("tooltip".into());
        hint.attrs.pointer_events = PointerEvents::None;
        let gap = Points(4.0);
        for prop in [
            crate::OverlayProp::Hint(Some(crate::overlay::HINT_DELAY)),
            crate::OverlayProp::Placement(crate::overlay::Placement::Top),
            crate::OverlayProp::Offset(gap),
            crate::OverlayProp::Margin(gap),
        ] {
            super::host::set(&mut hint, Prop::Overlay(prop));
        }
        hint.children.push(self.0);
        node.children.push(hint);
    }
}

impl<C: Component> IntoTooltip for ComponentElement<C> {
    fn apply_tooltip(self, node: &mut ElNode) {
        self.into_element().apply_tooltip(node);
    }
}

/// Makes `hint`, an element whose root is a hint overlay
/// ([`super::Overlay::hint`]: `nsh_base`'s `Tooltip`), the tooltip of
/// `node` as it is, with no overlay of the core's around it (its
/// [`IntoTooltip`]).
#[doc(hidden)]
pub fn __hint_tooltip(node: &mut ElNode, hint: AnyElement) {
    let mut hint = hint.0;
    hint.key = Some("tooltip".into());
    node.children.push(hint);
}

/// Elements that take touches.
pub trait Interactive: Element {
    /// A hint about it, shown above it on the desktops while the pointer
    /// rests on it (after half a second), until the pointer leaves or
    /// presses it; never on touch screens, and it never takes the pointer.
    /// The element is shown as it is; `nsh_base`'s `Tooltip` is the tooltip
    /// itself, with its own placement, delay and reports.
    fn tooltip(mut self, tooltip: impl IntoTooltip) -> Self {
        tooltip.apply_tooltip(self.node());
        self
    }

    /// A local file drag entered this desktop drop destination.
    fn on_file_drag_enter<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::FileDragEnter,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// A local file drag left this desktop drop destination.
    fn on_file_drag_leave<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::FileDragLeave,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// Local files or directories were dropped on this desktop destination.
    fn on_file_drop<M>(self, listener: impl IntoListener<events::FileDropEvent, M>) -> Self {
        self.on(
            EventKind::FileDrop,
            events::typed(listener.into_listener(), events::file_drop),
        )
    }

    /// The mouse came over it or an element inside it (never on touches):
    /// where (the DOM's `mouseenter`).
    fn on_mouse_enter<M>(self, listener: impl IntoListener<MouseEvent, M>) -> Self {
        self.on(
            EventKind::MouseEnter,
            events::typed(listener.into_listener(), events::mouse),
        )
    }

    /// The mouse left it and the elements inside it, or the window: where
    /// it was last (the DOM's `mouseleave`).
    fn on_mouse_leave<M>(self, listener: impl IntoListener<MouseEvent, M>) -> Self {
        self.on(
            EventKind::MouseLeave,
            events::typed(listener.into_listener(), events::mouse),
        )
    }

    /// The mouse moved over it (or an element inside it), with or without
    /// a button down ([`MouseEvent::pressed_button`]), or a modifier key
    /// changed while it rests there with none down: where, in it and in its
    /// root view, at most once per frame.
    fn on_mouse_move<M>(self, listener: impl IntoListener<MouseEvent, M>) -> Self {
        self.on(
            EventKind::MouseMove,
            events::typed(listener.into_listener(), events::mouse),
        )
    }

    /// The secondary button was pressed over it (a right click,
    /// Control-click on Apple platforms): where, to open a menu at
    /// (`page_x`, `page_y`). The nearest element that listens hears it;
    /// a text input or selectable text nearer shows its own menu instead.
    fn on_context_menu<M>(self, listener: impl IntoListener<ContextMenuEvent, M>) -> Self {
        self.on(
            EventKind::ContextMenu,
            events::typed(listener.into_listener(), events::context_menu),
        )
    }

    /// It took the keyboard focus: an input, or a view that takes presses
    /// reached by Tab (or `focus()`) on the platforms that move the focus
    /// between pressables.
    fn on_focus<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::Focus,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// It lost the keyboard focus.
    fn on_blur<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::Blur,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// Handles presses.
    fn on_press<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::Press,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// Handles presses held for about half a second.
    fn on_long_press<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::LongPress,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// A finger went down on the element.
    fn on_press_down<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::PressDown,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// The press ended, inside or outside the element.
    fn on_press_up<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::PressUp,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// Its frame changed (relative to its parent).
    fn on_layout<M>(self, listener: impl IntoListener<Bounds<Points>, M>) -> Self {
        self.on(
            EventKind::Layout,
            events::typed(listener.into_listener(), events::layout),
        )
    }

    /// Touches on it or inside it, every phase (custom gestures): the
    /// elements around the finger hear them from it outwards. To have them
    /// alone, claim them ([`Interactive::claim_touches`]).
    fn on_touch<M>(self, listener: impl IntoListener<TouchEvent, M>) -> Self {
        self.on(
            EventKind::Touch,
            events::typed(listener.into_listener(), events::touch),
        )
    }

    /// Claims the touches of a gesture as `claim` says (TS:
    /// `onStartShouldSetResponder`, `PanResponder`): as the responder it
    /// hears them alone (`on_responder_*`), and native scroll views around
    /// it stop taking them over. Several claims may be given.
    fn claim_touches(mut self, claim: super::TouchClaim) -> Self {
        if let Some(pan) = claim.pan {
            super::host::set(self.node(), Prop::PanActivation(Some(pan)));
        }
        super::responder::of(self.node()).claims.push(claim);
        self
    }

    /// As the responder, refuses to hand the touches over to an element
    /// around it that claims them (TS: `onResponderTerminationRequest`
    /// returning false); a native scroll view that started dragging first
    /// still takes them.
    fn keep_touches(mut self, keep: bool) -> Self {
        super::responder::of(self.node()).keep = keep;
        self
    }

    /// It became the responder (TS: `onResponderGrant`).
    fn on_responder_grant<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).grant = Some(listener.into_listener());
        self
    }

    /// It claimed the touches, but the responder kept them (TS:
    /// `onResponderReject`).
    fn on_responder_reject<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).reject = Some(listener.into_listener());
        self
    }

    /// As the responder, a finger went down (the first one too, after the
    /// grant; TS: `onResponderStart`).
    fn on_responder_start<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).start = Some(listener.into_listener());
        self
    }

    /// As the responder, the fingers moved (TS: `onResponderMove`).
    fn on_responder_move<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).moved = Some(listener.into_listener());
        self
    }

    /// As the responder, a finger lifted (TS: `onResponderEnd`).
    fn on_responder_end<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).end = Some(listener.into_listener());
        self
    }

    /// The last finger lifted: it is no longer the responder (TS:
    /// `onResponderRelease`).
    fn on_responder_release<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).release = Some(listener.into_listener());
        self
    }

    /// Another element or a native gesture took the touches over, or the
    /// system cancelled them (TS: `onResponderTerminate`).
    fn on_responder_terminate<M>(
        mut self,
        listener: impl IntoListener<super::ResponderEvent, M>,
    ) -> Self {
        super::responder::of(self.node()).terminate = Some(listener.into_listener());
        self
    }

    /// Drags move these values natively (by the drag's translation from
    /// where they were), with no engine work per frame; bind them to its
    /// transform to follow the finger. `on_pan_end` reports where they
    /// ended, to spring them on.
    fn pan_values(
        mut self,
        x: Option<&super::AnimatedValue>,
        y: Option<&super::AnimatedValue>,
    ) -> Self {
        let x = x.and_then(|v| v.node().live());
        let y = y.and_then(|v| v.node().live());
        let prop = Prop::PanValues(x.as_ref().map(|n| n.id()), y.as_ref().map(|n| n.id()));
        super::host::set(self.node(), prop);
        let bound = &mut self.node().attrs.bound;
        bound.extend(x);
        bound.extend(y);
        self
    }

    /// Enables native pans without replacing their values or listeners.
    /// A disabled pan leaves presses and scrolling to the content.
    fn pan_enabled(mut self, enabled: impl IntoReactive<bool>) -> Self {
        super::host::bind_prop(self.node(), enabled, Prop::PanEnabled);
        self
    }

    /// On iOS, a vertical pan shares descendant scroll views' touches and
    /// follows only the downward distance left after scrolling to the top.
    /// Other platforms keep their normal pan and scroll arbitration.
    fn pan_scroll_handoff(mut self, enabled: impl IntoReactive<bool>) -> Self {
        super::host::bind_prop(self.node(), enabled, Prop::PanScrollHandoff);
        self
    }

    /// Two-finger pinches scale `scale` natively (multiplying the value it
    /// has when the pinch starts; TS: `pinch={{ scale }}`); bind it to its
    /// transform ([`Element::bind_scale`]). `on_pinch_start` /
    /// `on_pinch_end` report the pinches.
    fn pinch_value(mut self, scale: &super::AnimatedValue) -> Self {
        if let Some(node) = scale.node().live() {
            super::host::set(self.node(), Prop::PinchValue(Some(node.id())));
            self.node().attrs.bound.push(node);
        }
        self
    }

    /// Two-finger rotations turn `angle` natively, in degrees (added to
    /// the value it has when the rotation starts; TS: `rotation={{ angle
    /// }}`); bind it to its transform ([`Element::bind_rotate`]).
    fn rotation_value(mut self, angle: &super::AnimatedValue) -> Self {
        if let Some(node) = angle.node().live() {
            super::host::set(self.node(), Prop::RotationValue(Some(node.id())));
            self.node().attrs.bound.push(node);
        }
        self
    }

    /// A drag started on it (the platform recognizes it).
    fn on_pan_start<M>(self, listener: impl IntoListener<PanEvent, M>) -> Self {
        self.on(
            EventKind::PanStart,
            events::typed(listener.into_listener(), events::pan),
        )
    }

    /// The drag ended, with its velocity.
    fn on_pan_end<M>(self, listener: impl IntoListener<PanEvent, M>) -> Self {
        self.on(
            EventKind::PanEnd,
            events::typed(listener.into_listener(), events::pan),
        )
    }

    /// A pinch started (its scale).
    fn on_pinch_start<M>(self, listener: impl IntoListener<GestureEvent, M>) -> Self {
        self.on(
            EventKind::PinchStart,
            events::typed(listener.into_listener(), events::pinch),
        )
    }

    /// The pinch ended.
    fn on_pinch_end<M>(self, listener: impl IntoListener<GestureEvent, M>) -> Self {
        self.on(
            EventKind::PinchEnd,
            events::typed(listener.into_listener(), events::pinch),
        )
    }

    /// A two-finger rotation started (its angle).
    fn on_rotation_start<M>(self, listener: impl IntoListener<GestureEvent<Radians>, M>) -> Self {
        self.on(
            EventKind::RotationStart,
            events::typed(listener.into_listener(), events::rotation),
        )
    }

    /// The rotation ended.
    fn on_rotation_end<M>(self, listener: impl IntoListener<GestureEvent<Radians>, M>) -> Self {
        self.on(
            EventKind::RotationEnd,
            events::typed(listener.into_listener(), events::rotation),
        )
    }

    /// An assistive technology performed an action (its name).
    fn on_accessibility_action<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.on(
            EventKind::AccessibilityAction,
            events::typed(listener.into_listener(), events::action),
        )
    }

    /// Handles native event `kind` with its raw payload (the element
    /// listens to it).
    fn on<M>(mut self, kind: EventKind, listener: impl IntoListener<EventPayload, M>) -> Self {
        self.node().handlers.push((kind, listener.into_listener()));
        self
    }

    /// Presses also count this far outside it.
    fn hit_slop(mut self, insets: EdgeInsets) -> Self {
        super::host::set(self.node(), Prop::HitSlop(insets));
        self
    }

    /// How long a press must last to be a long press, in milliseconds.
    fn long_press_delay(mut self, ms: f32) -> Self {
        super::host::set(self.node(), Prop::LongPressDelay(Some(ms)));
        self
    }

    /// The press ripple (Android).
    fn ripple(mut self, ripple: crate::props::Ripple) -> Self {
        super::host::set(self.node(), Prop::Ripple(Some(ripple)));
        self
    }

    /// The elevation shadow (Android).
    fn elevation(mut self, elevation: impl Into<Points>) -> Self {
        super::host::set(self.node(), Prop::Elevation(elevation.into()));
        self
    }

    /// The system material of a backdrop blur (iOS).
    fn backdrop_material(mut self, material: crate::BackdropMaterial) -> Self {
        super::host::set(self.node(), Prop::BackdropMaterial(material));
        self
    }

    /// The id UI tests find it by.
    fn test_id(mut self, id: &str) -> Self {
        super::host::set(self.node(), Prop::TestId(Some(id.into())));
        self
    }

    /// Whether a desktop press drags the window and a double click follows
    /// the system's title-bar behavior. The nearest explicit value wins;
    /// inputs and press/touch handlers inside a drag region stay interactive.
    /// Set false on a child to exclude it from its parent's drag region.
    fn window_drag(mut self, enabled: impl IntoReactive<bool>) -> Self {
        super::host::bind_prop(self.node(), enabled, |enabled| {
            Prop::WindowDrag(Some(enabled))
        });
        self
    }

    /// Whether the view is a stop of the keyboard focus (Tab): true makes
    /// any view one, whether or not it takes presses (a component that
    /// takes its keys while focused, through `on_focus` / `on_blur` and the
    /// keymap, without taking the presses of a pressable around it); false
    /// leaves a view that takes presses to the pointer, as a backdrop that
    /// closes a popover is. Unset, the views that take presses are stops
    /// ([`crate::ViewProps::focus_stop`]).
    fn focusable(mut self, focusable: impl IntoReactive<bool>) -> Self {
        super::host::bind_prop(self.node(), focusable, |focusable| {
            Prop::Focusable(Some(focusable))
        });
        self
    }

    /// The id inputs name an input accessory by (`nativeID`).
    fn native_id(mut self, id: &str) -> Self {
        super::host::set(self.node(), Prop::NativeId(Some(id.into())));
        self
    }

    /// Styles while pressed (native: nothing runs).
    fn active(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::ACTIVE, s);
        self
    }

    /// Styles while a pointer hovers it (iPad, Mac, mice).
    fn hover(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::HOVER, s);
        self
    }

    /// Styles while focused.
    fn focus(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::FOCUS, s);
        self
    }

    /// Styles while [`Interactive::disabled`] (Tailwind's `disabled:`).
    fn disabled_style(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.style().extend_as(Variant::DISABLED, s);
        self
    }

    /// No presses nor press feedback; screen readers say it is disabled.
    fn disabled(mut self, disabled: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(disabled, |a, disabled| {
            a.disabled = disabled;
            a.state.disabled = disabled;
        });
        self
    }

    /// An app's style while selected (`accessibility_state` `selected`;
    /// TS: a `Button`'s `selectedStyle`), as `selected:` classes apply.
    fn selected_style(mut self, style: impl IntoReactive<Style>) -> Self {
        Style::apply(self.node(), style, Variant::SELECTED, |a, patch| {
            super::host::set_in(&mut a.props, Prop::SelectedStyle(patch))
        });
        self
    }

    /// An app's style while checked (`accessibility_state` `checked`, not
    /// mixed: a checkbox's, a switch's, a radio's), as `checked:` classes
    /// apply.
    fn checked_style(mut self, style: impl IntoReactive<Style>) -> Self {
        Style::apply(self.node(), style, Variant::CHECKED, |a, patch| {
            super::host::set_in(&mut a.props, Prop::CheckedStyle(patch))
        });
        self
    }

    /// An app's style while indeterminate (`accessibility_state` `checked`
    /// mixed: a checkbox's `indeterminate`), as `indeterminate:` classes
    /// apply.
    fn indeterminate_style(mut self, style: impl IntoReactive<Style>) -> Self {
        Style::apply(self.node(), style, Variant::INDETERMINATE, |a, patch| {
            super::host::set_in(&mut a.props, Prop::IndeterminateStyle(patch))
        });
        self
    }

    /// An app's style while expanded (`accessibility_state` `expanded`: a
    /// `Popover`'s or `Menu`'s trigger while its popup is open), as
    /// `aria-expanded:` classes apply.
    fn expanded_style(mut self, style: impl IntoReactive<Style>) -> Self {
        Style::apply(self.node(), style, Variant::EXPANDED, |a, patch| {
            super::host::set_in(&mut a.props, Prop::ExpandedStyle(patch))
        });
        self
    }

    /// Styles it as checked while `checked` holds (its `checked:` classes
    /// and [`Self::checked_style`]), as a part of a control that is: a
    /// switch's track and thumb, a checkbox's mark (`gpui-base`'s
    /// `SwitchThumb::new(checked)`). Screen readers hear it from the
    /// control alone, so the part is no second checkable element.
    fn project_checked(mut self, checked: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(checked, |a, checked| {
            project(a, crate::tailwind::state::CHECKED, checked)
        });
        self
    }

    /// Styles it as indeterminate while `indeterminate` holds (its
    /// `indeterminate:` classes and [`Self::indeterminate_style`]), as a
    /// part of a control that is: a checkbox's indicator (`gpui-base`'s
    /// `CheckboxIndicator::state(CheckboxState::Indeterminate)`). Screen
    /// readers hear it from the control alone.
    fn project_indeterminate(mut self, indeterminate: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(indeterminate, |a, indeterminate| {
            project(a, crate::tailwind::state::INDETERMINATE, indeterminate)
        });
        self
    }

    /// Styles it as disabled while `disabled` holds (its `disabled:`
    /// classes and [`Self::disabled_style`]), as a part of a disabled
    /// control (`gpui-base`'s `SwitchThumb::disabled`). The control takes
    /// no presses and tells screen readers; the part keeps its own.
    fn project_disabled(mut self, disabled: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(disabled, |a, disabled| {
            project(a, crate::tailwind::state::DISABLED, disabled)
        });
        self
    }

    /// Styles it as focused while `focused` holds (its `focus:` classes
    /// and focus styles), as the part the keyboard is on inside a control
    /// that keeps the focus itself: the cell of a one-time-code input that
    /// takes the next character, the highlighted option of a list (NSH
    /// has no active descendant). The platform's focus stays where it is.
    fn project_focused(mut self, focused: impl IntoReactive<bool>) -> Self {
        self.node().bind_attr(focused, |a, focused| {
            project(a, crate::tailwind::state::FOCUSED, focused)
        });
        self
    }
}

/// Sets or clears `bit` of the states an element shows as a part.
fn project(a: &mut Attrs, bit: u16, on: bool) {
    if on {
        a.projected_states |= bit;
    } else {
        a.projected_states &= !bit;
    }
}

macro_rules! element {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone)]
        pub struct $name(ElNode);

        impl Element for $name {
            fn node(&mut self) -> &mut ElNode {
                &mut self.0
            }
        }

        impl IntoElement for $name {
            fn into_element(self) -> AnyElement {
                AnyElement(self.0)
            }
        }

        impl Accessible for $name {}

        impl IntoTooltip for $name {
            fn apply_tooltip(self, node: &mut ElNode) {
                self.into_element().apply_tooltip(node);
            }
        }
    };
}

element! {
    /// A view (`<view>`), made by [`view`].
    View
}

element! {
    /// A text block (`<text>`), made by [`text`].
    Text
}

element! {
    /// An image (`<image>`), made by [`image`].
    Image
}

element! {
    /// A slot's node as a view places it ([`ParentElement::slot`]):
    /// style it like a view; its children are the app's.
    SlotElement
}

element! {
    /// A list as a view lays it out ([`ParentElement::list`]).
    ListElement
}

impl Interactive for View {}
impl ParentElement for View {}
impl Interactive for SlotElement {}
impl Interactive for Text {}
impl Interactive for Image {}

/// A text's children are its spans, as nested `<text>`s in JS: texts with
/// styles and presses of their own (a link inside a sentence), strings,
/// and views and images placed inline, wrapping with the words. The core
/// merges them into one paragraph.
impl ParentElement for Text {
    fn child<M>(mut self, child: impl IntoChild<M>) -> Self {
        let at = self.0.children.len();
        child.__push_into(&mut self.0.children);
        for el in &mut self.0.children[at..] {
            *el = span(std::mem::replace(el, ElNode::new(Tag::View)));
        }
        self
    }

    fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
        self.0
            .children
            .extend(children.into_iter().map(|c| span(c.into_element().0)));
        self
    }
}

/// A child of a text: a bare string (a text with nothing of its own) is a
/// piece of its content, anything else a span or an inline element.
fn span(mut el: ElNode) -> ElNode {
    if el.tag == Tag::Text
        && matches!(el.kind, ElKind::Plain)
        && el.key.is_none()
        && el.children.is_empty()
        && el.handlers.is_empty()
        && el.style.is_empty()
        && el.attrs == Attrs::default()
        && !el.is_bound()
    {
        el.kind = ElKind::Raw;
    }
    el
}

impl Text {
    /// The original source of this text, with local UTF-16 ranges mapped to
    /// absolute UTF-8 byte offsets. `None` clears the source mapping.
    pub fn text_source(
        mut self,
        source: impl IntoReactive<Option<Arc<crate::TextSource>>>,
    ) -> Self {
        super::host::bind_prop(&mut self.0, source, Prop::TextSource);
        self
    }

    /// The highlight of its selection, when it is selectable.
    pub fn selection_color(mut self, color: impl IntoReactive<Hsla>) -> Self {
        super::host::bind_prop(&mut self.0, color, |c: Hsla| {
            Prop::SelectionColor(Some(Color::from(c)))
        });
        self
    }

    /// Shrinks the font, down to `min_scale` of it, to fit its lines.
    pub fn shrink_to_fit(mut self, min_scale: impl IntoReactive<f32>) -> Self {
        super::host::set(&mut self.0, Prop::AdjustsFontSizeToFit(true));
        super::host::bind_prop(&mut self.0, min_scale, Prop::MinimumFontScale);
        self
    }

    /// Whether its fonts follow the system's text size (true by default;
    /// TS: `allowFontScaling`).
    pub fn allow_font_scaling(mut self, allow: impl IntoReactive<bool>) -> Self {
        super::host::bind_prop(&mut self.0, allow, Prop::AllowFontScaling);
        self
    }

    /// At most this multiple of its fonts' sizes with the system's text
    /// size (TS: `maxFontSizeMultiplier`; 0: no limit).
    pub fn max_font_size_multiplier(mut self, multiplier: impl IntoReactive<f32>) -> Self {
        super::host::bind_prop(&mut self.0, multiplier, Prop::MaxFontSizeMultiplier);
        self
    }
}

impl Image {
    /// Shown until it loads (a URL, an `asset:/` URI or an
    /// [`super::ImageAsset`]).
    pub fn placeholder(mut self, src: impl IntoReactive<super::ImageSrc>) -> Self {
        super::host::bind_prop(&mut self.0, src, |src: super::ImageSrc| {
            Prop::Image(crate::ImageProp::Placeholder(Some(ImageSource {
                uri: src.uri.to_arc(),
                size: src.size.map(|(w, h)| crate::geometry::size_pt(w, h)),
                scales: src.scales,
                data: None,
            })))
        });
        self
    }

    /// Draws its opaque pixels in `color` (a template image, an icon).
    pub fn tint_color(self, color: impl IntoReactive<super::AdaptiveColor>) -> Self {
        Styled::tint_color(self, color)
    }

    /// Blurs it.
    pub fn blur_radius(mut self, radius: impl Into<Points>) -> Self {
        super::host::set(
            &mut self.0,
            Prop::Image(crate::ImageProp::BlurRadius(radius.into())),
        );
        self
    }

    /// Fades it in over `ms` milliseconds once loaded.
    pub fn fade_duration(mut self, ms: impl IntoReactive<f32>) -> Self {
        super::host::bind_prop(&mut self.0, ms, |ms| {
            Prop::Image(crate::ImageProp::FadeDuration(Some(ms)))
        });
        self
    }

    /// It loaded: its size in pixels.
    pub fn on_load<M>(self, listener: impl IntoListener<Size<DevicePixels>, M>) -> Self {
        self.on(
            EventKind::Load,
            events::typed(listener.into_listener(), events::pixel_size),
        )
    }

    /// It failed to load (the message).
    pub fn on_error<M>(self, listener: impl IntoListener<str, M>) -> Self {
        self.on(
            EventKind::Error,
            events::typed(listener.into_listener(), events::message),
        )
    }

    /// It started loading.
    pub fn on_load_start<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::LoadStart,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// It finished loading, or failed.
    pub fn on_load_end<M>(self, listener: impl IntoListener<(), M>) -> Self {
        self.on(
            EventKind::LoadEnd,
            events::typed(listener.into_listener(), events::unit),
        )
    }

    /// Its download went on: bytes so far and in all (at most every 100
    /// ms; none for images already in memory).
    pub fn on_progress<M>(self, listener: impl IntoListener<events::ImageProgress, M>) -> Self {
        self.on(
            EventKind::Progress,
            events::typed(listener.into_listener(), events::image_progress),
        )
    }
}

impl super::Scrollable for ListElement {}

impl super::ListLayout for ListElement {
    fn config(&mut self) -> &mut ListConfig {
        match &mut self.0.kind {
            ElKind::List(list) => &mut list.config,
            _ => unreachable!("a ListElement is a list"),
        }
    }

    fn bound_config(&mut self) -> &mut Vec<BoundListConfig> {
        &mut self.0.bound_list
    }
}

/// A named slot (an `Option<Slot>` prop): `Some` while the app passes
/// content for it. Placed with [`ParentElement::slot`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    name: &'static str,
}

impl Slot {
    pub(crate) fn new(name: &'static str) -> Self {
        Self { name }
    }

    /// Its name (its prop's, in JS).
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The slot's node, to style and place (its children are the app's).
    pub fn element(self) -> SlotElement {
        let mut node = ElNode::new(Tag::View);
        node.kind = ElKind::Slot(self.name);
        SlotElement(node)
    }
}

/// The app's virtualized rows (an `Items` prop): in JS the component takes
/// `each` and a row renderer like `List`. Placed with
/// [`ParentElement::list`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Items {
    name: &'static str,
}

impl Items {
    #[doc(hidden)]
    pub const fn __new(name: &'static str) -> Self {
        Self { name }
    }
}

/// A piece of the app's content to place: one JSX child
/// ([`ParentElement::children_each`]) or a list row's content
/// ([`ParentElement::list`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Child(ChildRef);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildRef {
    Js(NodeId),
    Row,
}

impl Child {
    pub(crate) fn js(id: NodeId) -> Self {
        Self(ChildRef::Js(id))
    }

    pub(crate) fn row() -> Self {
        Self(ChildRef::Row)
    }
}

impl IntoElement for Child {
    fn into_element(self) -> AnyElement {
        let mut node = ElNode::new(Tag::View);
        node.kind = match self.0 {
            ChildRef::Js(id) => ElKind::JsChild(id),
            ChildRef::Row => ElKind::Children,
        };
        AnyElement(node)
    }
}

/// A view.
pub fn view() -> View {
    View(ElNode::new(Tag::View))
}

/// A text block showing `content`, then its children (spans:
/// [`ParentElement`] for [`Text`]).
pub fn text(content: impl IntoReactive<SharedString>) -> Text {
    let mut node = ElNode::new(Tag::Text);
    match content.into_reactive() {
        Reactive::Static(content) => node.text = Some(content),
        Reactive::Bound(content) => {
            node.text = Some(SharedString::default());
            node.bound_text = Some(content);
        }
    }
    Text(node)
}

/// An image loading `src`: a URL, a file path or `asset:/` URI, or an
/// [`super::ImageAsset`] (`asset!("logo@2x.png")`), which lays out at its
/// natural size before it loads.
pub fn image(src: impl IntoReactive<super::ImageSrc>) -> Image {
    let mut node = ElNode::new(Tag::Image);
    node.bind_attr(src, |a, src| a.src = Some(src));
    Image(node)
}

/// The JSX children of a component (a `Children` prop): placed where the
/// view puts it, among the view's own children.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Children {
    present: bool,
}

impl Children {
    pub(crate) fn new(present: bool) -> Self {
        Self { present }
    }

    /// The app passed none.
    pub fn is_empty(&self) -> bool {
        !self.present
    }
}

impl IntoElement for Children {
    fn into_element(self) -> AnyElement {
        let mut node = ElNode::new(Tag::View);
        node.kind = ElKind::Children;
        AnyElement(node)
    }
}

/// Another component in a view ([`Component::element`]). Its styles go
/// after the component's own, like an app's classes, and so do its inline
/// style, animated values and insets ([`Element`]'s), on the component's
/// root; its state styles ([`Self::active`], [`Self::hover`],
/// [`Self::focus`], [`Self::disabled_style`], [`Styled::selected`],
/// [`Styled::checked`]) follow the states of that root, as an app's
/// `active:` / `hover:` classes on a TSX component do. It hears and is to
/// assistive technologies what the component says (its events and props):
/// it is not [`Interactive`] or [`Accessible`]. The element a
/// `#[component]`'s constructor makes (`button()`) wraps one
/// ([`ComponentBuilder`]).
pub struct ComponentElement<C: Component> {
    node: ElNode,
    _component: PhantomData<fn() -> C>,
}

impl<C: Component> ComponentElement<C> {
    /// The element of `C` given `props`: what a component's constructor
    /// (`button()`) and [`Component::element`] start from.
    #[doc(hidden)]
    pub fn __new(props: C::Props) -> Self {
        Self::new(props)
    }

    /// Its props, for the setters a `#[component]` makes on its element.
    #[doc(hidden)]
    pub fn __props_mut(&mut self) -> &mut C::Props {
        match &mut self.node.kind {
            ElKind::Component(c) => c
                .props
                .as_any_mut()
                .downcast_mut::<C::Props>()
                .expect("a component element holds its component's props"),
            _ => unreachable!("a component element is a component's"),
        }
    }

    pub(crate) fn new(props: C::Props) -> Self {
        let mut node = ElNode::new(Tag::View);
        node.kind = ElKind::Component(ComponentEl {
            name: super::component::name_of::<C>(),
            make: super::component::make_instance::<C>,
            spec: ComponentSpec::of::<C>,
            props: Box::new(props),
            on_event: Vec::new(),
        });
        Self {
            node,
            _component: PhantomData,
        }
    }

    /// Fills its slot `slot` (its prop's JS name: `header`) with `content`
    /// (in place of what filled it): the component's view places it as it
    /// is where it places the slot, with no node around it (a node of its
    /// own only where the view styles the slot).
    pub fn fill(mut self, slot: &'static str, content: impl IntoElement) -> Self {
        self.node
            .children
            .retain(|c| !matches!(c.kind, ElKind::Fill(s) if s == slot));
        let mut fill = ElNode::new(Tag::View);
        fill.kind = ElKind::Fill(slot);
        fill.children.push(content.into_element().0);
        self.node.children.push(fill);
        self
    }

    /// Fills its `Items` prop with rows of this view (TS: `each` and the
    /// row renderer, `keyExtractor`, `header`, ...): the rows,
    /// their keys, header, footer, empty view, separators, sticky rows,
    /// viewability, the refresh and the end reached are `list`'s, rendered
    /// and handled by this component; the layout and the styles are the
    /// placing component's ([`ParentElement::list`]), so `list`'s own are
    /// left out.
    pub fn items(mut self, list: super::VirtualList) -> Self {
        match <C::Props as super::Props>::ITEMS {
            Some(name) => self.node.children.push(list.into_items(name)),
            None => {
                log::error!(target: "js", "{} has no `Items` prop to fill", super::component::name_of::<C>())
            }
        }
        self
    }

    /// Styles while its root is pressed (Tailwind's `active:`; TS: an
    /// `active:` class or `activeStyle` given the component), applied
    /// natively. The root follows presses when it handles them (a
    /// [`Interactive::on_press`] of the component's view).
    pub fn active(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node.style.extend_as(Variant::ACTIVE, s);
        self
    }

    /// Styles while a pointer hovers its root (`hover:`).
    pub fn hover(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node.style.extend_as(Variant::HOVER, s);
        self
    }

    /// Styles while its root has focus (`focus:`).
    pub fn focus(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node.style.extend_as(Variant::FOCUS, s);
        self
    }

    /// Styles while its root is disabled (`disabled:`): the component's
    /// view disables it ([`Interactive::disabled`], a `disabled` prop).
    pub fn disabled_style(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node.style.extend_as(Variant::DISABLED, s);
        self
    }

    /// Puts `handle` on this component: its updates go to it.
    pub fn component_ref(mut self, handle: &super::ComponentRef<C>) -> Self {
        self.node.attrs.element_ref = handle.element().target();
        self
    }

    /// Handles its events (they then do not reach the app). Given several
    /// times, every listener hears them, in order. The element a
    /// `#[component]`'s constructor makes has a listener method per event
    /// instead (`.on_press(..)`: [`ComponentBuilder`]); this stays for
    /// components implemented by hand.
    pub fn on_event<M>(mut self, listener: impl IntoListener<C::Event, M>) -> Self {
        let listener = listener.into_listener();
        if let ElKind::Component(c) = &mut self.node.kind {
            c.on_event.push(listener.wrap(|inner, event: &dyn Any| {
                if let Some(event) = event.downcast_ref::<C::Event>() {
                    inner(event);
                }
            }));
        }
        self
    }

    /// Handles the events `pick` picks, with the data it gives: the listener
    /// method of one event (`on_press`) that `#[derive(Event)]` generates
    /// calls it.
    #[doc(hidden)]
    pub fn __on_variant<T: ?Sized + 'static, M>(
        self,
        pick: fn(&C::Event) -> Option<&T>,
        listener: impl IntoListener<T, M>,
    ) -> Self {
        let listener = listener.into_listener();
        self.on_event(listener.wrap(move |inner, event: &C::Event| {
            if let Some(data) = pick(event) {
                inner(data);
            }
        }))
    }
}

/// The element of a `#[component]`, as its constructor makes it: a
/// component is made and set up in Rust as a primitive is (`view()`),
/// as JSX does in TSX. `#[component] fn Picker` makes `picker()` (the
/// function's name in snake case), which returns a `PickerElement` with
/// each prop at its default and
///
/// - a setter per prop, named as its field (`.disabled(..)`): a value, a
///   signal, a memo or a prop of the field's type, or a closure returning
///   one (bound); an `Option<T>` prop takes a `T` (`.label("Pick one")`),
///   a slot the content to fill it with (`.header(text(..))`), the
///   children are its [`ParentElement::child`]ren;
/// - a listener method per event, named as its TSX handler in snake case
///   (`onSelect` is `.on_select(..)`): a unit variant's takes
///   `move || ..`, a one-field variant's `move |value: &T| ..`, a
///   named-field variant's the event itself;
/// - styles ([`Styled`]: they go on the component's root), with this
///   trait's for the root's states, and a
///   [`ComponentRef`](super::ComponentRef).
///
/// A prop's setter comes before an element method of the same name (a
/// component's `selected` prop before [`Styled::selected`], its `size`
/// before [`Styled::size`]; call those as `Styled::selected(element, ..)`).
///
/// ```
/// use nsh_core::prelude::*;
///
/// /// The props of [`Picker`].
/// #[derive(Clone, PartialEq, Props)]
/// pub struct PickerProps {
///     /// The options.
///     pub options: Prop<Vec<SharedString>>,
///     /// No presses.
///     #[prop(default)]
///     pub disabled: Prop<bool>,
///     /// What screen readers say.
///     pub label: Prop<Option<SharedString>>,
/// }
///
/// /// What a [`Picker`] reports.
/// #[derive(Event)]
/// pub enum PickerEvent {
///     /// Pressed.
///     Press,
///     /// An option was picked: its index.
///     Select(u32),
/// }
///
/// /// Picks an option.
/// #[component]
/// pub fn Picker(props: PickerProps, cx: Scope<PickerEvent>) -> impl IntoElement {
///     view()
///         .disabled(props.disabled)
///         .on_press(move || cx.emit(PickerEvent::Select(0)))
/// }
///
/// #[component]
/// pub fn Form() -> impl IntoElement {
///     let busy = signal(false);
///     let picked = signal(None::<u32>);
///     view().child(
///         picker()
///             .options(vec![SharedString::from("Tea"), "Coffee".into()])
///             .disabled(move || busy.get())
///             .label("Drink")
///             .on_press(move || log::info!("pressed"))
///             .on_select(move |&index: &u32| picked.set(Some(index)))
///             .px_4()
///             .active(|s| s.opacity(0.6)),
///     )
/// }
/// ```
pub trait ComponentBuilder: Element {
    /// Its component.
    type Component: Component;

    /// The element it builds.
    #[doc(hidden)]
    fn __element(&mut self) -> &mut ComponentElement<Self::Component>;

    /// Styles while its root is pressed (Tailwind's `active:`; TS: an
    /// `active:` class or `activeStyle` given the component), applied
    /// natively. The root follows presses when it handles them (a
    /// [`Interactive::on_press`] of the component's view).
    fn active(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node().style.extend_as(Variant::ACTIVE, s);
        self
    }

    /// Styles while a pointer hovers its root (`hover:`).
    fn hover(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node().style.extend_as(Variant::HOVER, s);
        self
    }

    /// Styles while its root has focus (`focus:`).
    fn focus(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node().style.extend_as(Variant::FOCUS, s);
        self
    }

    /// Styles while its root is disabled (`disabled:`): the component's
    /// view disables it ([`Interactive::disabled`], a `disabled` prop).
    fn disabled_style(mut self, f: impl FnOnce(StyleRefinement) -> StyleRefinement) -> Self {
        let s = f(StyleRefinement::default());
        self.node().style.extend_as(Variant::DISABLED, s);
        self
    }

    /// Puts `handle` on this component: its updates go to it.
    fn component_ref(mut self, handle: &super::ComponentRef<Self::Component>) -> Self {
        self.__element().node.attrs.element_ref = handle.element().target();
        self
    }
}

impl<C: Component> Element for ComponentElement<C> {
    fn node(&mut self) -> &mut ElNode {
        &mut self.node
    }
}

/// The content of a nested component: `.child(..)` / `.children(..)` are
/// its `Children`, [`ComponentElement::fill`] its slots, placed where its
/// view places the app's.
impl<C: Component> ParentElement for ComponentElement<C> {}

impl<C: Component> IntoElement for ComponentElement<C> {
    fn into_element(self) -> AnyElement {
        AnyElement(self.node)
    }
}

#[cfg(test)]
mod tests {
    use super::{AnyEvent, Rc, SharedEvent};
    use crate::element::{Event, EventToJs};

    #[derive(Debug, PartialEq, Event)]
    enum ForwardedEvent {
        Value(u32),
    }

    #[test]
    fn a_shared_event_preserves_its_rust_type_and_data() {
        let event: Rc<dyn AnyEvent> = Rc::new(ForwardedEvent::Value(42));
        let shared = SharedEvent {
            name: event.name(),
            event,
        };
        assert_eq!(shared.name(), "value");
        assert_eq!(
            shared.as_any().downcast_ref::<ForwardedEvent>(),
            Some(&ForwardedEvent::Value(42))
        );
    }
}
