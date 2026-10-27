//! Calls from JS into Rust, and what goes back, as Rust values: no JSON
//! between JS and Rust components, modules or classes.
//!
//! `nsh-js` converts a call's JS arguments into the Rust types in the JS
//! call (the generated decoders, [`super::JsValue::from_js`]) and queues
//! what the call does as an op ([`RustOp`]): a closure holding the typed
//! arguments, which the core runs in order with the UI's ops (a module
//! function with a [`super::ModuleCx`], the start of an `async` function's
//! or member's task, a ref's method). Results are boxed Rust values
//! ([`ToJs`]) the core hands back in its event stream ([`JsEvent`]), in
//! order with the other events, and `nsh-js` converts them when it settles
//! the promise. A Rust component's props cross the same way: decoded in
//! the JS call into an [`AnyValue`], set by the core.
//!
//! Platform native components (the components an embedder registers in
//! its own language) keep JSON (`Prop::ComponentProp`, `EventPayload::Native`,
//! `Command::Native`): their values cross into another language.

use std::{
    any::Any,
    cell::{Cell, RefCell},
    collections::VecDeque,
    fmt,
    rc::Rc,
    sync::Arc,
};

use super::{
    ModuleCx, ModuleFuture, PropError,
    callback::JsCall,
    js::{JsHost, JsOwned},
};
use crate::{EventKind, EventPayload, NodeId};

/// A Rust value of some type, decoded from JS for a component's prop.
/// Cheap to clone; two are equal when they are the same value (the prop
/// keeps its own comparison of what it holds).
#[derive(Clone)]
pub struct AnyValue(Rc<dyn Any>);

impl AnyValue {
    /// `value`, type-erased.
    pub fn new<T: 'static>(value: T) -> Self {
        Self(Rc::new(value))
    }

    /// The value, if it is a `T`.
    pub fn take<T: Clone + 'static>(self) -> Option<T> {
        self.0.downcast::<T>().ok().map(Rc::unwrap_or_clone)
    }
}

impl PartialEq for AnyValue {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for AnyValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AnyValue")
    }
}

/// A Rust value JS gets: converted when JS receives it (a call's result,
/// an event's data).
pub trait ToJs: 'static {
    /// The value as a JS value of `host`.
    fn to_js_value<'a>(self: Box<Self>, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>;
}

impl<T: super::Ret + 'static> ToJs for T {
    fn to_js_value<'a>(self: Box<Self>, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        (*self).into_js(host)
    }
}

/// The result of a call JS waits for: the value, or the message its
/// promise rejects with.
pub type JsResult = Result<Box<dyn ToJs>, super::Thrown>;

/// A module function with a context, its arguments decoded: run by the
/// core in order with the UI's ops.
pub type OpCall = Box<dyn FnOnce(&mut ModuleCx) -> JsResult>;

/// The start of an `async` function's or member's task, its arguments
/// decoded: the core starts it in order with the UI's ops.
pub type TaskStart = Box<dyn FnOnce() -> ModuleFuture>;

/// A method of a component's ref, its arguments decoded: called with the
/// API the component registered (`None`: an API of another type).
pub type MethodCall = Box<dyn FnOnce(&dyn Any) -> Option<JsResult>>;

/// What a call JS made into Rust does, carried by an op.
pub enum RustCall {
    /// A module function with a context.
    Op(OpCall),
    /// The start of an `async` function's or member's task.
    Task(TaskStart),
    /// A method of the ref of the component on node `0`.
    Method(NodeId, MethodCall),
    /// The place of a JS call posted during a synchronous call from JS
    /// ([`Posts::park`]): applied (dropped), the call runs after what the
    /// ops before it post.
    Post(ParkedPost),
}

/// A call JS made into Rust ([`crate::Op::Rust`]): what it does, and the
/// number of the promise its result settles (0: none).
pub struct RustOp {
    /// The promise's call number (0: JS does not wait).
    pub call: u32,
    /// What it does.
    pub run: RustCall,
}

impl fmt::Debug for RustOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match &self.run {
            RustCall::Op(_) => "Op",
            RustCall::Task(_) => "Task",
            RustCall::Method(..) => "Method",
            RustCall::Post(_) => "Post",
        };
        write!(f, "RustOp({kind}, call {})", self.call)
    }
}

/// A Rust component's event JS hears: its name and data.
#[doc(hidden)]
pub trait EventToJs {
    /// The event's name (`press`: JS's `onPress`).
    fn name(&self) -> &'static str;
    /// Its data as a JS value of `host`.
    fn data_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError>;
    /// The handler takes the items of the data as its arguments.
    fn spread(&self) -> bool {
        false
    }
}

/// What the core hands JS after a commit, in order: the platform's and the
/// core's events, and the Rust values for JS (a Rust component's events,
/// whether its lazy children are placed, calls' results).
pub enum JsEvent {
    /// An event of a node (layout, scroll, a platform component's).
    Event(NodeId, EventKind, EventPayload),
    /// An event of the Rust component hosted by `host`.
    Component {
        /// The component's host node.
        host: NodeId,
        /// The event.
        event: Box<dyn EventToJs>,
    },
    /// Whether the Rust component hosted by `host` places its lazy
    /// children now.
    Children {
        /// The component's host node.
        host: NodeId,
        /// Placed.
        wanted: bool,
    },
    /// The Rust component hosted by `host` places the content of its
    /// render prop `prop` (`Option<Renderer<T>>`) for `key` with `value`,
    /// which JS did not render yet: JS calls the app's function with it
    /// and inserts what it returns into the host in a holder view of its
    /// own (`componentRender`: the prop, U+001F, the key), replacing the
    /// one it made for the key before. The core places the holder.
    Render {
        /// The component's host node.
        host: NodeId,
        /// The prop holding the app's function.
        prop: &'static str,
        /// The key, unique among the component's renders of the prop.
        key: super::SharedString,
        /// The value to render.
        value: std::rc::Rc<dyn super::RenderValue>,
    },
    /// No element of the component's render (`prop`, `key`) is placed any
    /// more ([`Self::Render`]): JS removes its holder and disposes what it
    /// rendered.
    Unrender {
        /// The component's host node.
        host: NodeId,
        /// The prop holding the app's function.
        prop: &'static str,
        /// The key.
        key: super::SharedString,
    },
    /// The result of call `call` (its promise settles).
    Reply {
        /// The call number.
        call: u32,
        /// The value or the rejection's message.
        result: JsResult,
    },
}

impl fmt::Debug for JsEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JsEvent::Event(id, kind, payload) => write!(f, "Event({id}, {kind:?}, {payload:?})"),
            JsEvent::Component { host, event } => write!(f, "Component({host}, {})", event.name()),
            JsEvent::Children { host, wanted } => write!(f, "Children({host}, {wanted})"),
            JsEvent::Render {
                host, prop, key, ..
            } => write!(f, "Render({host}, {prop}, {key})"),
            JsEvent::Unrender { host, prop, key } => write!(f, "Unrender({host}, {prop}, {key})"),
            JsEvent::Reply { call, result } => write!(f, "Reply({call}, ok: {})", result.is_ok()),
        }
    }
}

// --- Posts ----------------------------------------------------------------------

/// The place in [`Posts`] of a call posted during a synchronous call from
/// JS, which [`RustCall::Post`] carries: dropping it lets the call run
/// there, whichever path drops it (the op applied, or dropped unapplied).
#[doc(hidden)]
pub struct ParkedPost {
    posts: Posts,
    id: u64,
}

impl Drop for ParkedPost {
    fn drop(&mut self) {
        self.posts.release(self.id);
    }
}

impl fmt::Debug for ParkedPost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ParkedPost({})", self.id)
    }
}

/// The calls of JS functions Rust posts ([`super::Callback::post`],
/// `call_async`) for the next JS turn, in one ordered queue. One per
/// engine, made by it and handed to `nsh-js` and the core. Cheap to clone.
///
/// The calls run in the order they were posted, with one exception that
/// keeps JS's program order: a call posted during a synchronous call from
/// JS is parked in its place until the op JS sent after it is applied
/// ([`RustCall::Post`]), and what the ops before that one post while the
/// core applies them goes before it. So a call a task posts after the
/// synchronous call runs after it, and one an op JS sent before the call
/// posts runs before it. The queue runs up to the first place not
/// released yet; a place is released whichever way its op goes (applied,
/// or dropped unapplied: [`ParkedPost`]), so no lost op stalls it.
#[derive(Clone, Default)]
pub struct Posts(Rc<PostsInner>);

#[derive(Default)]
struct PostsInner {
    queue: RefCell<VecDeque<Entry>>,
    next_parked: Cell<u64>,
    /// The core is applying an op JS sent ([`Posts::in_op`]).
    in_op: Cell<u32>,
    notify: RefCell<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// JS stopped for good: calls are dropped (their replies say so).
    closed: Cell<bool>,
}

enum Entry {
    Ready(JsCall),
    /// Parked as `id`; released (runnable) once its op goes.
    Parked {
        id: u64,
        call: JsCall,
        released: bool,
    },
}

impl fmt::Debug for Posts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Posts")
            .field("queued", &self.0.queue.borrow().len())
            .finish()
    }
}

impl Posts {
    /// An empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Calls `notify` when a call becomes runnable (it wakes the engine).
    pub fn set_notify(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        *self.0.notify.borrow_mut() = Some(notify);
    }

    fn wake(&self) {
        let notify = self.0.notify.borrow().clone();
        if let Some(notify) = notify {
            notify();
        }
    }

    /// Queues `call` and wakes the engine.
    #[doc(hidden)]
    pub fn post(&self, call: JsCall) {
        if self.0.closed.get() {
            // Dropped: a reply waiting for it is told JS stopped.
            drop(call);
            return;
        }
        {
            let mut queue = self.0.queue.borrow_mut();
            // An op's post goes before the places of the calls JS posted
            // after sending it (parked, not released: their ops come
            // later).
            let at = (self.0.in_op.get() > 0)
                .then(|| {
                    queue.iter().position(|e| {
                        matches!(
                            e,
                            Entry::Parked {
                                released: false,
                                ..
                            }
                        )
                    })
                })
                .flatten();
            match at {
                Some(at) => queue.insert(at, Entry::Ready(call)),
                None => queue.push_back(Entry::Ready(call)),
            }
        }
        self.wake();
    }

    /// Runs `f`, the work of an op JS sent: what it posts goes before the
    /// calls JS posted after the op.
    pub(crate) fn in_op<R>(&self, f: impl FnOnce() -> R) -> R {
        struct Raised<'a>(&'a Cell<u32>);
        impl Drop for Raised<'_> {
            fn drop(&mut self) {
                self.0.set(self.0.get() - 1);
            }
        }
        self.0.in_op.set(self.0.in_op.get() + 1);
        let _raised = Raised(&self.0.in_op);
        f()
    }

    /// Queues `call` parked in its place until the place it returns is
    /// dropped: when its op is applied, or dropped by any other path (the
    /// call then runs in its place, or with the queue when it closes), so
    /// a lost op never holds back the calls after it.
    #[doc(hidden)]
    pub fn park(&self, call: JsCall) -> ParkedPost {
        let id = self.0.next_parked.get() + 1;
        self.0.next_parked.set(id);
        if self.0.closed.get() {
            drop(call);
        } else {
            self.0.queue.borrow_mut().push_back(Entry::Parked {
                id,
                call,
                released: false,
            });
        }
        ParkedPost {
            posts: self.clone(),
            id,
        }
    }

    /// Lets the call parked as `id` run in its place.
    fn release(&self, id: u64) {
        let found = self.0.queue.borrow_mut().iter_mut().any(|e| match e {
            Entry::Parked {
                id: parked,
                released,
                ..
            } if *parked == id => {
                *released = true;
                true
            }
            _ => false,
        });
        if found {
            self.wake();
        }
    }

    /// No JS runs any more (the VM stopped or went): the queued calls are
    /// dropped, and so are those posted later (their replies say so).
    pub fn close(&self) {
        self.0.closed.set(true);
        let queue = std::mem::take(&mut *self.0.queue.borrow_mut());
        drop(queue);
    }

    /// Whether a call can run now.
    pub fn has_calls(&self) -> bool {
        matches!(
            self.0.queue.borrow().front(),
            Some(Entry::Ready(_) | Entry::Parked { released: true, .. })
        )
    }

    /// The calls that can run now, in order: up to the first parked one not
    /// released yet.
    #[doc(hidden)]
    pub fn take_calls(&self) -> Vec<JsCall> {
        let mut queue = self.0.queue.borrow_mut();
        let mut out = Vec::new();
        while let Some(entry) = queue.front() {
            if matches!(
                entry,
                Entry::Parked {
                    released: false,
                    ..
                }
            ) {
                break;
            }
            match queue.pop_front() {
                Some(Entry::Ready(call) | Entry::Parked { call, .. }) => out.push(call),
                None => break,
            }
        }
        out
    }
}
