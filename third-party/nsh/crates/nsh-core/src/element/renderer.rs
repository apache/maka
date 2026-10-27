//! Render functions a component takes (an `Option<Renderer<T>>` prop): in
//! JS a function `(value: T) => JSX.Element` the app passes, in Rust a
//! closure. The component asks it for content where it places it, with a
//! key and a value: `props.render_code.get().map(|r| r.render(key, code))`.
//!
//! A Rust closure is called on the spot. The app's JS function is called by
//! JS: [`Renderer::render`] makes a view of the core's (a placeholder, its
//! [`Attrs::render`](super::Attrs) naming the component's host, the prop,
//! the key and the value), and after each commit the core asks JS for the
//! content of each (prop, key) placed with a value JS did not render yet
//! ([`super::JsEvent::Render`]), and tells it when none is placed any more
//! ([`super::JsEvent::Unrender`]). JS renders into a holder view of its own
//! (`componentRender`), which it inserts into the host; the core places the
//! holder as the placeholder's only child (`core/components.rs`).

use std::{any::Any, cell::Cell, fmt, rc::Rc};

use super::{
    AnyElement, ElNode, Element, Interactive, IntoElement, JsHost, JsOwned, JsValue, PropError,
    SharedString,
};
use crate::{NodeId, Tag};

/// A function of the app's that renders values of `T` (an
/// `Option<Renderer<T>>` prop; in TypeScript `(value: T) => JSX.Element`).
///
/// [`Renderer::render`] places what it renders for a value, under a key:
/// content rendered for a key stays while an element of that key is placed
/// with an equal value, and is rendered again when the value changes.
pub struct Renderer<T> {
    kind: Kind<T>,
}

enum Kind<T> {
    /// The app's JS function: the prop of this name of the component on
    /// node `host`.
    Js { prop: &'static str, host: NodeId },
    /// A Rust view's closure.
    Rust(Rc<dyn Fn(&T) -> AnyElement>),
}

impl<T> Clone for Renderer<T> {
    fn clone(&self) -> Self {
        Self {
            kind: match &self.kind {
                Kind::Js { prop, host } => Kind::Js { prop, host: *host },
                Kind::Rust(f) => Kind::Rust(f.clone()),
            },
        }
    }
}

impl<T> PartialEq for Renderer<T> {
    fn eq(&self, other: &Self) -> bool {
        match (&self.kind, &other.kind) {
            (Kind::Js { prop: a, host: h }, Kind::Js { prop: b, host: k }) => a == b && h == k,
            (Kind::Rust(a), Kind::Rust(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}

impl<T> fmt::Debug for Renderer<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            Kind::Js { prop, host } => write!(f, "Renderer({prop} of {host})"),
            Kind::Rust(_) => write!(f, "Renderer(<closure>)"),
        }
    }
}

thread_local! {
    /// The host whose props JS is decoding ([`__decoding_props_of`]).
    static DECODING: Cell<NodeId> = const { Cell::new(0) };
}

/// Runs `f` (the decoding of a prop JS set) for the component on node
/// `host`: a renderer it makes is that component's.
#[doc(hidden)]
pub fn __decoding_props_of<R>(host: NodeId, f: impl FnOnce() -> R) -> R {
    struct Restore(NodeId);
    impl Drop for Restore {
        fn drop(&mut self) {
            DECODING.with(|d| d.set(self.0));
        }
    }
    let _restore = Restore(DECODING.with(|d| d.replace(host)));
    f()
}

impl<T: JsValue + Clone + PartialEq + 'static> Renderer<T> {
    /// A renderer of a Rust view: `f` makes the content for a value.
    pub fn new<E: IntoElement>(f: impl Fn(&T) -> E + 'static) -> Self {
        Self {
            kind: Kind::Rust(Rc::new(move |value| f(value).into_element())),
        }
    }

    /// The app's function in prop `prop` of the component whose props are
    /// being decoded ([`__decoding_props_of`]).
    #[doc(hidden)]
    pub fn __js(prop: &'static str) -> Self {
        Self::__js_of(prop, DECODING.with(Cell::get))
    }

    /// The app's function in prop `prop` of the component on node `host`.
    #[doc(hidden)]
    pub fn __js_of(prop: &'static str, host: NodeId) -> Self {
        Self {
            kind: Kind::Js { prop, host },
        }
    }

    /// The content rendered for `value`, under `key` (unique among the
    /// component's renders of this renderer), in a view of its own to
    /// style and place as any view (in a text: an inline view).
    ///
    /// The app's JS function renders it after the commit that places it,
    /// and again only when it is placed with a value that differs; it is
    /// released once no element of the key is placed. A Rust closure runs
    /// each time this is called.
    pub fn render(&self, key: impl Into<SharedString>, value: T) -> Rendered {
        let mut node = ElNode::new(Tag::View);
        match &self.kind {
            Kind::Rust(f) => node.children.push(f(&value).0),
            Kind::Js { prop, host } => {
                node.attrs.render = Some(RenderAt(Rc::new(RenderPlace {
                    host: *host,
                    prop,
                    key: key.into(),
                    value: Rc::new(value),
                })));
            }
        }
        Rendered(node)
    }
}

/// What a [`Renderer`] rendered, placed as a view: style it like one (its
/// child is the content).
#[derive(Clone)]
pub struct Rendered(ElNode);

impl Element for Rendered {
    fn node(&mut self) -> &mut ElNode {
        &mut self.0
    }
}

impl IntoElement for Rendered {
    fn into_element(self) -> AnyElement {
        AnyElement(self.0)
    }
}

impl super::Accessible for Rendered {}
impl Interactive for Rendered {}

/// A value JS renders: converted when the core asks JS for its content,
/// and compared with the one rendered last.
#[doc(hidden)]
pub trait RenderValue: 'static {
    /// The value as a JS value of `host`.
    fn render_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>;
    /// Whether `other` is an equal value of the same type.
    fn same(&self, other: &dyn RenderValue) -> bool;
    /// The value, to downcast.
    fn as_any(&self) -> &dyn Any;
}

impl<T: JsValue + PartialEq + 'static> RenderValue for T {
    fn render_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        JsValue::to_js(self, host)
    }

    fn same(&self, other: &dyn RenderValue) -> bool {
        other.as_any().downcast_ref::<T>() == Some(self)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Where a JS renderer's content goes: the component, the prop and the
/// key, and the value to render.
pub(crate) struct RenderPlace {
    pub(crate) host: NodeId,
    pub(crate) prop: &'static str,
    pub(crate) key: SharedString,
    pub(crate) value: Rc<dyn RenderValue>,
}

impl RenderPlace {
    /// The (prop, key) as JS names its holder (`componentRender`): the
    /// prop, U+001F, the key.
    pub(crate) fn slot(&self) -> std::sync::Arc<str> {
        format!("{}\u{1f}{}", self.prop, self.key).into()
    }
}

/// An element's [`RenderPlace`] (an attribute the core diffs: equal when
/// the place and the value are).
#[derive(Clone)]
pub(crate) struct RenderAt(pub(crate) Rc<RenderPlace>);

impl PartialEq for RenderAt {
    fn eq(&self, other: &Self) -> bool {
        let (a, b) = (&*self.0, &*other.0);
        Rc::ptr_eq(&self.0, &other.0)
            || (a.host == b.host && a.prop == b.prop && a.key == b.key && a.value.same(&*b.value))
    }
}

impl fmt::Debug for RenderAt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RenderAt({} {}:{})",
            self.0.host, self.0.prop, self.0.key
        )
    }
}
