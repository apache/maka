//! Signals for Rust components: the reactive graph of
//! [`crate::reactive`] with Rust values and closures, as TSX has it
//! (`signal`, `computed`, `effect`, `batch`, `untracked`, `cleanup`, context).
//!
//! Handles ([`Signal`], [`Memo`], [`ReadSignal`]) are `Copy` indices into
//! the graph, so closures and async blocks capture them as they are. What is
//! made under an owner (a component, an effect, a branch of `when`, a row of
//! `each`) is disposed with it; a handle of a disposed node reads as gone
//! ([`Signal::try_get`]) and panics when read as live. The UI's other
//! handles (animated values, element refs) are kept the same way
//! (`Kept`), but find their value gone rather than panic.
//!
//! The graph is the engine's: the core enters it ([`Runtime::enter`]) while
//! Rust code of the components runs on the engine thread, and the functions
//! here act on the graph entered.

use std::{
    any::{Any, TypeId},
    cell::{Cell, RefCell, UnsafeCell},
    fmt,
    marker::PhantomData,
    panic::AssertUnwindSafe,
    rc::Rc,
};

use crate::reactive::{self as r, DISPOSED, Equals, Kind, NONE, UNOWNED};

/// A value in the graph (`None`: none yet, an effect's).
type Value = Option<Rc<dyn Any>>;
type Func = Rc<dyn Fn(Value) -> Value>;
type Compare = fn(&dyn Any, &dyn Any) -> bool;

/// The graph's host for Rust: values are `Rc<dyn Any>`, computations
/// closures.
#[derive(Clone, Copy)]
pub(crate) struct Rust;

/// What the Rust host keeps in the graph.
#[derive(Default)]
pub(crate) struct RustData {
    /// Panics of computations, with the owner they ran under, for the core
    /// to report ([`Runtime::take_failures`]).
    failures: Vec<(u32, String)>,
    runaway: bool,
    /// Events components that run once emitted, for the core.
    emits: Vec<super::once::Emitted>,
    /// What components read of the core ([`super::ambient`]).
    pub(crate) ambient: super::ambient::Ambient,
    /// The APIs views registered, by host ([`super::Scope::methods`]).
    apis: rustc_hash::FxHashMap<crate::NodeId, ApiEntry>,
    /// The error boundaries ([`super::catch_error`]): what fails under the
    /// owner sets its signal.
    boundaries: rustc_hash::FxHashMap<Owner, Signal<Option<super::ComponentError>>>,
}

/// Makes the current owner an error boundary: what fails under it sets
/// `failed`, for as long as it lives.
pub(crate) fn register_boundary(failed: Signal<Option<super::ComponentError>>) {
    let owner = Owner::current();
    with_data(|d| d.boundaries.insert(owner, failed));
    cleanup(move || {
        with_data(|d| d.boundaries.remove(&owner));
    });
}

/// The nearest error boundary at or above `owner`.
pub(crate) fn boundary_of(owner: Owner) -> Option<Signal<Option<super::ComponentError>>> {
    let mut at = Some(owner);
    while let Some(owner) = at.filter(Owner::is_live) {
        if let Some(signal) = with_data(|d| d.boundaries.get(&owner).copied()) {
            return Some(signal);
        }
        at = owner.parent();
    }
    None
}

/// A registered [`super::Api`], its type erased (a method's call, made
/// in the JS call, downcasts it).
#[derive(Clone)]
struct ApiEntry {
    api: Rc<dyn Any>,
}

/// Registers `api` as the ref of the component on `host` for as long as the
/// current owner lives.
pub(crate) fn register_api<A: super::Api>(host: crate::NodeId, api: A) {
    let entry = ApiEntry { api: Rc::new(api) };
    with_data(|d| d.apis.insert(host, entry));
    cleanup(move || {
        with_data(|d| d.apis.remove(&host));
    });
}

/// The API of type `A` the component on `host` registered.
pub(crate) fn api_of<A: super::Api>(host: crate::NodeId) -> Option<Rc<A>> {
    let entry = with_data(|d| d.apis.get(&host).cloned())?;
    entry.api.downcast::<A>().ok()
}

/// Calls `call` (a method its arguments were decoded for) with the API of
/// the component on `host`; `None` without one, or with one of another
/// type.
pub(crate) fn call_api(host: crate::NodeId, call: super::MethodCall) -> Option<super::JsResult> {
    // Out of the data first: the method writes signals.
    let entry = with_data(|d| d.apis.get(&host).cloned())?;
    call(&*entry.api)
}

/// Runs `f` on the entered runtime's data.
pub(crate) fn with_data<R>(f: impl FnOnce(&mut RustData) -> R) -> R {
    f(&mut graph().data)
}

/// [`with_data`] where a graph is entered (the engine's thread, while it
/// runs Rust code), else `None`.
pub(crate) fn try_with_data<R>(f: impl FnOnce(&mut RustData) -> R) -> Option<R> {
    let graph = CURRENT.with(Cell::get);
    // SAFETY: an entered graph lives until its guard drops; the borrow
    // ends with `f`.
    (!graph.is_null()).then(|| f(unsafe { &mut (*graph).data }))
}

/// Queues `event` of the component on `host` for the core.
pub(crate) fn emit(host: crate::NodeId, event: Box<dyn super::builder::AnyEvent>) {
    graph().data.emits.push((host, event));
}

thread_local! {
    /// The graph entered on this thread ([`Runtime::enter`]).
    #[allow(
        clippy::missing_const_for_thread_local,
        reason = "it is const; clippy misreads Android's expansion"
    )]
    static CURRENT: Cell<*mut r::Graph<Rust>> = const { Cell::new(std::ptr::null_mut()) };
}

// SAFETY: the graph is the one entered on this thread; the graph's
// functions and the handles here take only short borrows of it.
unsafe impl r::Host for Rust {
    type Value = Value;
    type Func = Func;
    type Equals = Compare;
    type Cleanup = Box<dyn FnOnce()>;
    type Context = (TypeId, Rc<dyn Any>);
    type Data = RustData;

    #[inline]
    unsafe fn graph<'a>(self) -> &'a mut r::Graph<Rust> {
        let graph = CURRENT.with(Cell::get);
        assert!(
            !graph.is_null(),
            "no reactive runtime: signals are used on the engine thread, while components run"
        );
        // SAFETY: an entered graph lives until its guard drops.
        unsafe { &mut *graph }
    }

    #[inline]
    fn empty() -> Value {
        None
    }

    #[inline]
    fn dup(self, v: &Value) -> Value {
        v.clone()
    }

    #[inline]
    fn free(self, v: Value) {
        drop(v);
    }

    #[inline]
    fn dup_func(self, f: &Func) -> Func {
        f.clone()
    }

    #[inline]
    fn free_func(self, f: Func) {
        drop(f);
    }

    fn dup_equals(self, e: &Compare) -> Compare {
        *e
    }

    fn free_equals(self, _: Compare) {}

    fn call(self, f: &Func, prev: Value) -> Option<Value> {
        match std::panic::catch_unwind(AssertUnwindSafe(|| f(prev))) {
            Ok(value) => Some(value),
            Err(panic) => {
                let message = super::component::panic_message(panic);
                // SAFETY: a short borrow.
                let graph = unsafe { self.graph() };
                let owner = graph.owner();
                graph.data.failures.push((owner, message));
                None
            }
        }
    }

    #[inline]
    fn same(self, a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Some(a), Some(b)) => Rc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }

    fn truthy(self, v: &Value) -> bool {
        v.as_ref()
            .and_then(|v| v.downcast_ref::<bool>())
            .copied()
            .unwrap_or(v.is_some())
    }

    fn custom_changed(self, e: &Compare, prev: Value, next: &Value) -> bool {
        match (&prev, next) {
            (Some(a), Some(b)) => !e(&**a, &**b),
            (None, None) => false,
            _ => true,
        }
    }

    fn run_cleanup(self, f: Box<dyn FnOnce()>) {
        if let Err(panic) = std::panic::catch_unwind(AssertUnwindSafe(f)) {
            let message = super::component::panic_message(panic);
            // SAFETY: a short borrow.
            let graph = unsafe { self.graph() };
            let owner = graph.owner();
            graph.data.failures.push((owner, message));
        }
    }

    fn free_cleanup(self, f: Box<dyn FnOnce()>) {
        drop(f);
    }

    fn runaway(self) {
        // SAFETY: a short borrow.
        let graph = unsafe { self.graph() };
        graph.data.runaway = true;
        log::error!(target: "js", "potential infinite loop: an effect keeps changing what it reads");
    }
}

fn graph<'a>() -> &'a mut r::Graph<Rust> {
    // SAFETY: every borrow here is short and ends before the next call
    // into the graph's functions.
    unsafe { r::Host::graph(Rust) }
}

/// The reactive graph of an engine's Rust components.
pub struct Runtime {
    graph: Box<UnsafeCell<r::Graph<Rust>>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            graph: Box::new(UnsafeCell::new(r::Graph::new(RustData::default()))),
        }
    }
}

impl fmt::Debug for Runtime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Runtime")
    }
}

/// While it lives, the graph it entered is the thread's
/// ([`Runtime::enter`]).
#[must_use = "the runtime is entered while the guard lives"]
pub struct Entered {
    previous: *mut r::Graph<Rust>,
}

impl Drop for Entered {
    fn drop(&mut self) {
        CURRENT.with(|c| c.set(self.previous));
    }
}

impl Runtime {
    /// Makes this runtime the thread's until the guard drops (entries nest).
    pub fn enter(&self) -> Entered {
        let previous = CURRENT.with(|c| c.replace(self.graph.get()));
        Entered { previous }
    }

    /// The panics of computations since the last call, with the owner each
    /// ran under.
    pub(crate) fn take_failures(&self) -> Vec<(Owner, String)> {
        let _entered = self.enter();
        let graph = graph();
        std::mem::take(&mut graph.data.failures)
            .into_iter()
            .map(|(id, message)| (Owner::of(graph, id), message))
            .collect()
    }

    /// The events components emitted since the last call.
    pub(crate) fn take_emits(&self) -> Vec<super::once::Emitted> {
        let _entered = self.enter();
        std::mem::take(&mut graph().data.emits)
    }

    /// The graph's slots in use.
    #[cfg(test)]
    pub(crate) fn slots_in_use(&self) -> usize {
        let _entered = self.enter();
        graph().slots().0
    }

    /// Frees what the graph holds (at teardown; no component code runs).
    pub(crate) fn free_all(&self) {
        let _entered = self.enter();
        graph().free_all(Rust);
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Cleanups and values may hold handles: release them inside the
        // runtime, before it goes.
        self.free_all();
    }
}

/// A handle of a node: its index and generation.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct Handle {
    id: u32,
    generation: u32,
}

impl Handle {
    fn of(graph: &r::Graph<Rust>, id: u32) -> Self {
        Self {
            id,
            generation: graph.generation(id),
        }
    }

    fn live(self) -> bool {
        graph().live(self.id, self.generation, u32::MAX)
    }

    /// The node, or a panic naming where the handle was made.
    #[track_caller]
    fn expect(self, what: &str) -> u32 {
        assert!(
            self.live(),
            "{what} read or written after its owner was disposed"
        );
        self.id
    }
}

/// A node of the graph, whatever it is (a signal, a memo), by handle.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Node(Handle);

impl Node {
    /// `f` of its value, subscribing the running computation (`what` names
    /// it if it is gone).
    #[track_caller]
    pub(crate) fn with<T: 'static, R>(self, what: &str, f: impl FnOnce(&T) -> R) -> R {
        read_value(self.0.expect(what), true, f)
    }

    /// Writes `value` to it (a signal's node): what read it runs again,
    /// unless the signal finds it equal.
    #[track_caller]
    pub(crate) fn set<T: 'static>(self, value: T) {
        r::write(Rust, self.0.expect("a prop"), Some(Rc::new(value)));
    }
}

fn read_value<T: 'static, R>(id: u32, tracked: bool, f: impl FnOnce(&T) -> R) -> R {
    let value = if tracked {
        r::read(Rust, id)
    } else {
        graph().value(id).clone()
    };
    let value = value.expect("a signal always holds a value");
    f(value
        .downcast_ref::<T>()
        .expect("a handle reads the type it was made with"))
}

fn compare<T: PartialEq + 'static>(a: &dyn Any, b: &dyn Any) -> bool {
    a.downcast_ref::<T>() == b.downcast_ref::<T>()
}

/// How a signal decides that a write changed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalEquals {
    /// Every write notifies (types without `PartialEq`, or values that
    /// change in place).
    Never,
}

/// A value that is read in bindings and written from anywhere: reading it
/// in a computation subscribes the computation (TS: `signal(value)`).
pub struct Signal<T> {
    handle: Handle,
    _t: PhantomData<fn() -> T>,
}

impl<T> Clone for Signal<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Signal<T> {}

impl<T> PartialEq for Signal<T> {
    fn eq(&self, other: &Self) -> bool {
        self.handle == other.handle
    }
}

impl<T> fmt::Debug for Signal<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Signal({})", self.handle.id)
    }
}

/// A new signal holding `value`, owned by the current owner. A write of an
/// equal value notifies no one (TS: `===`).
pub fn signal<T: PartialEq + 'static>(value: T) -> Signal<T> {
    make_signal(value, Equals::Custom(compare::<T>))
}

/// A new signal holding `value` whose every write notifies.
pub fn signal_with<T: 'static>(value: T, equals: SignalEquals) -> Signal<T> {
    match equals {
        SignalEquals::Never => make_signal(value, Equals::Never),
    }
}

/// A value of the current owner that is not reactive ([`stored`]): a
/// `Copy` handle to state closures share but nothing displays (a running
/// task, a cache). It goes with the owner.
pub struct Stored<T: 'static>(Signal<Rc<RefCell<T>>>);

impl<T> Clone for Stored<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Stored<T> {}

impl<T: 'static> Stored<T> {
    /// `f` of the value, which it may change (`f` must not reach this
    /// value again).
    #[track_caller]
    pub fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        self.0.with_untracked(|cell| f(&mut cell.borrow_mut()))
    }

    /// Replaces the value, returning the old one.
    #[track_caller]
    pub fn replace(&self, value: T) -> T {
        self.with(|v| std::mem::replace(v, value))
    }
}

impl<T: Clone + 'static> Stored<T> {
    /// A copy of the value (reading it subscribes nothing, unlike
    /// [`Signal::get`]).
    #[track_caller]
    pub fn get(&self) -> T {
        self.with(|v| v.clone())
    }
}

/// A value of the current owner that is not reactive: reading it subscribes
/// nothing, changing it notifies nothing.
pub fn stored<T: 'static>(value: T) -> Stored<T> {
    Stored(signal_with(
        Rc::new(RefCell::new(value)),
        SignalEquals::Never,
    ))
}

/// A value the current owner keeps for a `Copy` handle that is not a
/// signal ([`super::AnimatedValue`], [`super::ElementRef`]): released with
/// the owner (with no owner, it lives as long as the graph, as a signal
/// does). Unlike a signal's, its handle finds it gone afterwards rather
/// than panicking, and off the engine thread, where no graph is entered.
pub(crate) struct Kept<T: 'static> {
    handle: Handle,
    _t: PhantomData<fn() -> T>,
}

impl<T> Clone for Kept<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Kept<T> {}

impl<T> PartialEq for Kept<T> {
    fn eq(&self, other: &Self) -> bool {
        self.handle == other.handle
    }
}

impl<T: 'static> Kept<T> {
    /// Keeps `value` in the current owner. The `Rc` is the graph's value
    /// as it is (no allocation of its own).
    pub(crate) fn new(value: Rc<T>) -> Self {
        Self {
            handle: owned_signal(Some(value as Rc<dyn Any>), Equals::Never),
            _t: PhantomData,
        }
    }

    /// A handle of nothing: always gone.
    pub(crate) fn gone() -> Self {
        Self {
            handle: Handle {
                id: u32::MAX,
                generation: 0,
            },
            _t: PhantomData,
        }
    }

    /// `f` of the graph's value while the owner lives (and a graph is
    /// entered). `f` must not reach the graph: it runs inside a borrow.
    fn raw<R>(self, f: impl FnOnce(&Rc<dyn Any>) -> R) -> Option<R> {
        let graph = CURRENT.with(Cell::get);
        if graph.is_null() {
            return None;
        }
        // SAFETY: an entered graph lives until its guard drops; the borrow
        // ends with `f`, which does not reach the graph.
        let graph = unsafe { &*graph };
        let Handle { id, generation } = self.handle;
        if !graph.live(id, generation, u32::MAX) {
            return None;
        }
        graph.value(id).as_ref().map(f)
    }

    /// `f` of the value while its owner lives (and a graph is entered).
    /// `f` must not reach the graph: it runs inside a borrow of it.
    pub(crate) fn with<R>(self, f: impl FnOnce(&T) -> R) -> Option<R> {
        self.raw(|v| v.downcast_ref::<T>().map(f)).flatten()
    }

    /// Whether its owner lives (and a graph is entered).
    pub(crate) fn is_live(self) -> bool {
        self.raw(|_| ()).is_some()
    }

    /// The value while its owner lives (and a graph is entered).
    pub(crate) fn get(self) -> Option<Rc<T>> {
        self.raw(Rc::clone)?.downcast::<T>().ok()
    }
}

fn make_signal<T: 'static>(value: T, equals: Equals<Compare>) -> Signal<T> {
    Signal {
        handle: owned_signal(Some(Rc::new(value)), equals),
        _t: PhantomData,
    }
}

/// A signal node of the current owner; under [`DISPOSED`] one disposed at
/// once, its handle naming nothing.
fn owned_signal(value: Value, equals: Equals<Compare>) -> Handle {
    let graph = graph();
    let id = graph.owned_signal(value, equals);
    let handle = Handle::of(graph, id);
    if graph.owner() == DISPOSED {
        r::dispose(Rust, id);
    }
    handle
}

impl<T: 'static> Signal<T> {
    /// The value (a clone), subscribing the running computation.
    #[track_caller]
    pub fn get(&self) -> T
    where
        T: Clone,
    {
        self.with(T::clone)
    }

    /// `f` of the value, subscribing the running computation.
    #[track_caller]
    pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        read_value(self.handle.expect("a signal"), true, f)
    }

    /// The value (a clone), without subscribing.
    #[track_caller]
    pub fn get_untracked(&self) -> T
    where
        T: Clone,
    {
        self.with_untracked(T::clone)
    }

    /// `f` of the value, without subscribing.
    #[track_caller]
    pub fn with_untracked<R>(&self, f: impl FnOnce(&T) -> R) -> R {
        read_value(self.handle.expect("a signal"), false, f)
    }

    /// The value, or `None` once the signal's owner was disposed.
    pub fn try_get(&self) -> Option<T>
    where
        T: Clone,
    {
        self.handle.live().then(|| self.get())
    }

    /// Writes `value`: what read the signal runs again, unless it is equal
    /// to the current value.
    #[track_caller]
    pub fn set(&self, value: T) {
        r::write(Rust, self.handle.expect("a signal"), Some(Rc::new(value)));
    }

    /// Writes `value`; false (and nothing written) once the signal's owner
    /// was disposed.
    pub fn try_set(&self, value: T) -> bool {
        if !self.handle.live() {
            return false;
        }
        r::write(Rust, self.handle.id, Some(Rc::new(value)));
        true
    }

    /// Changes the value in place and writes it: every update notifies.
    /// The value is cloned only while something else holds it (a reader
    /// in the middle of `with`).
    #[track_caller]
    pub fn update(&self, f: impl FnOnce(&mut T))
    where
        T: Clone,
    {
        let id = self.handle.expect("a signal");
        let taken = graph().replace_value(id, None);
        let shared = taken
            .and_then(|v| v.downcast::<T>().ok())
            .expect("a signal holds its type");
        let mut value = Rc::try_unwrap(shared).unwrap_or_else(|shared| (*shared).clone());
        f(&mut value);
        r::write(Rust, id, Some(Rc::new(value)));
    }

    /// Its node.
    pub(crate) fn node(&self) -> Node {
        Node(self.handle)
    }

    /// A read-only view of the signal.
    pub fn read_only(&self) -> ReadSignal<T> {
        ReadSignal {
            handle: self.handle,
            _t: PhantomData,
        }
    }
}

/// A signal that can only be read (from [`Signal::read_only`]).
pub struct ReadSignal<T> {
    handle: Handle,
    _t: PhantomData<fn() -> T>,
}

impl<T> Clone for ReadSignal<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for ReadSignal<T> {}

impl<T> PartialEq for ReadSignal<T> {
    fn eq(&self, other: &Self) -> bool {
        self.handle == other.handle
    }
}

impl<T> fmt::Debug for ReadSignal<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ReadSignal({})", self.handle.id)
    }
}

/// A value computed from others and cached: it runs again only when what it
/// read changed, and notifies only when its result changed (TS:
/// `computed(fn)`).
pub struct Memo<T> {
    handle: Handle,
    _t: PhantomData<fn() -> T>,
}

impl<T> Clone for Memo<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Memo<T> {}

impl<T> PartialEq for Memo<T> {
    fn eq(&self, other: &Self) -> bool {
        self.handle == other.handle
    }
}

impl<T> fmt::Debug for Memo<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Memo({})", self.handle.id)
    }
}

/// A memo of `f`, owned by the current owner.
pub fn computed<T: PartialEq + 'static>(f: impl Fn() -> T + 'static) -> Memo<T> {
    let func: Func = Rc::new(move |_| Some(Rc::new(f()) as Rc<dyn Any>));
    let id = r::memo(Rust, func, None, Equals::Custom(compare::<T>), false);
    Memo {
        handle: Handle::of(graph(), id),
        _t: PhantomData,
    }
}

macro_rules! readable {
    ($name:ident, $what:literal) => {
        impl<T: 'static> $name<T> {
            /// The value (a clone), subscribing the running computation.
            #[track_caller]
            pub fn get(&self) -> T
            where
                T: Clone,
            {
                self.with(T::clone)
            }

            /// `f` of the value, subscribing the running computation.
            #[track_caller]
            pub fn with<R>(&self, f: impl FnOnce(&T) -> R) -> R {
                read_value(self.handle.expect($what), true, f)
            }

            /// The value (a clone), without subscribing.
            #[track_caller]
            pub fn get_untracked(&self) -> T
            where
                T: Clone,
            {
                self.with_untracked(T::clone)
            }

            /// `f` of the value, without subscribing.
            #[track_caller]
            pub fn with_untracked<R>(&self, f: impl FnOnce(&T) -> R) -> R {
                // A memo is brought up to date by a read: read it, untracked.
                untracked(|| self.with(f))
            }

            /// The value, or `None` once its owner was disposed.
            pub fn try_get(&self) -> Option<T>
            where
                T: Clone,
            {
                self.handle.live().then(|| self.get())
            }

            /// Its node.
            pub(crate) fn node(&self) -> Node {
                Node(self.handle)
            }
        }
    };
}

readable!(ReadSignal, "a signal");
readable!(Memo, "a memo");

/// Runs `f` now and again whenever what it read changes, after the
/// bindings of the change are updated (TS: `effect(fn)`). Owned by the
/// current owner.
pub fn effect(f: impl Fn() + 'static) {
    let func: Func = Rc::new(move |_| {
        f();
        None
    });
    r::effect(Rust, Kind::UserEffect, func, None);
}

/// A binding: runs `f` now and again whenever what it read changes, before
/// user effects.
pub(crate) fn render_effect(f: impl Fn() + 'static) {
    let func: Func = Rc::new(move |_| {
        f();
        None
    });
    r::effect(Rust, Kind::Effect, func, None);
}

/// Runs `f` before the current owner runs again or is disposed (TS:
/// `cleanup(fn)`). With no owner it never runs; under an owner disposed
/// while it ran ([`Owner::scope`]) it runs at once.
pub fn cleanup(f: impl FnOnce() + 'static) {
    if let Err(f) = graph().on_cleanup(Box::new(f))
        && graph().owner() == DISPOSED
    {
        r::Host::run_cleanup(Rust, f);
    }
}

/// Runs `f`; its writes notify together at its end (TS: `batch(fn)`).
pub fn batch<R>(f: impl FnOnce() -> R) -> R {
    rethrow(r::batch(Rust, shielded(f)))
}

/// Runs `f` without subscribing to what it reads (TS: `untracked(fn)`).
pub fn untracked<R>(f: impl FnOnce() -> R) -> R {
    rethrow(r::untracked(Rust, shielded(f)))
}

/// `f`, made to catch its panic: the graph functions that run app code
/// change the graph's state (the owner, the listener, the round of
/// updates) around it and restore it when it returns, so a panic must not
/// unwind through them ([`rethrow`] goes on once they returned).
fn shielded<R>(f: impl FnOnce() -> R) -> impl FnOnce() -> std::thread::Result<R> {
    move || std::panic::catch_unwind(AssertUnwindSafe(f))
}

/// `f`'s result, or its panic, going on now that the graph is consistent.
fn rethrow<R>(result: std::thread::Result<R>) -> R {
    result.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// Provides `value` to what the current owner makes from now on, however
/// deep; [`use_context`] finds the nearest of its type.
pub fn provide_context<T: Clone + 'static>(value: T) {
    let replaced = graph().provide((TypeId::of::<T>(), Rc::new(value) as Rc<dyn Any>));
    drop(replaced);
}

/// The nearest value of type `T` provided above the current owner.
pub fn use_context<T: Clone + 'static>() -> Option<T> {
    let mut frame = graph().context();
    while let Some(f) = frame {
        if f.data.0 == TypeId::of::<T>() {
            return f.data.1.downcast_ref::<T>().cloned();
        }
        frame = f.parent.clone();
    }
    None
}

/// An owner: what was made under it is disposed with it.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Owner(Option<Handle>);

impl fmt::Debug for Owner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(h) => write!(f, "Owner({})", h.id),
            None => f.write_str("Owner(none)"),
        }
    }
}

impl Owner {
    /// No owner: what is made under it lives until it is disposed itself.
    pub fn detached() -> Self {
        Owner(None)
    }

    fn of(graph: &r::Graph<Rust>, id: u32) -> Self {
        if id == NONE || id == UNOWNED {
            Owner(None)
        } else if id == DISPOSED {
            // A handle of no node: never live.
            Owner(Some(Handle { id, generation: 0 }))
        } else {
            Owner(Some(Handle::of(graph, id)))
        }
    }

    /// The owner of what runs now.
    pub fn current() -> Self {
        let graph = graph();
        Self::of(graph, graph.owner())
    }

    /// The owner it was made under (none for one made with no owner).
    pub(crate) fn parent(&self) -> Option<Owner> {
        let h = self.0?;
        if !h.live() {
            return None;
        }
        let graph = graph();
        let parent = Self::of(graph, graph.parent(h.id));
        parent.0.map(|_| parent)
    }

    /// Whether it is still live (not disposed).
    pub fn is_live(&self) -> bool {
        self.0.is_some_and(|h| h.live() && !graph().disposed(h.id))
    }

    /// Runs `f` under this owner, untracked (what it makes is this owner's;
    /// once it is disposed, what `f` makes is disposed at once).
    pub fn run<R>(&self, f: impl FnOnce() -> R) -> R {
        rethrow(r::with_owner(Rust, self.graph_id(), shielded(f)))
    }

    /// The graph's id of it: [`DISPOSED`] once it is disposed.
    fn graph_id(&self) -> u32 {
        match self.0 {
            Some(h) if self.is_live() => h.id,
            Some(_) => DISPOSED,
            None => NONE,
        }
    }

    /// The owner of what runs now, or none where no graph is entered.
    pub(crate) fn current_or_detached() -> Self {
        if CURRENT.with(Cell::get).is_null() {
            Self::detached()
        } else {
            Self::current()
        }
    }

    /// Runs `f` with this owner current, so what it makes is this owner's.
    /// Once the owner is disposed, before `f` or while it runs (a listener
    /// closing the view it belongs to), what `f` makes from then on is
    /// disposed at once: signals and memos panic when used, as disposed ones
    /// do, effects never run, cleanups (a task's cancel) run at once, and
    /// animated values and element refs do nothing. Unlike [`Self::run`] it
    /// is no batch and keeps the listener: writes notify as they happen, as
    /// they did before (listeners and tasks run their code this way).
    pub(crate) fn scope<R>(&self, f: impl FnOnce() -> R) -> R {
        /// Puts the previous owner back, on a panic too.
        struct Restore(r::SavedOwner);
        impl Drop for Restore {
            fn drop(&mut self) {
                graph().leave_owner(self.0);
            }
        }
        let _restore = Restore(graph().enter_owner(self.graph_id()));
        f()
    }

    /// Disposes it: what was made under it, its cleanups first.
    pub fn dispose(&self) {
        if let Some(h) = self.0
            && h.live()
        {
            r::dispose_owner(Rust, h.id);
        }
    }
}

/// Runs `f` in a new owner under the current one (it sees its context; the
/// current owner does not dispose it): the owner, to dispose, and `f`'s
/// result.
pub fn create_root<R>(f: impl FnOnce() -> R) -> (Owner, R) {
    let (id, result) = r::with_root(Rust, shielded(f));
    let owner = Owner::of(graph(), id);
    match result {
        Ok(r) => (owner, r),
        // What it made so far goes with it.
        Err(panic) => {
            owner.dispose();
            std::panic::resume_unwind(panic)
        }
    }
}

/// A value that is set once or bound: what element setters and props take
/// ([`IntoReactive`]).
pub enum Reactive<T> {
    /// A value set once (no binding).
    Static(T),
    /// A value read in a binding: a signal, a memo or a closure, run again
    /// when what it read changes.
    Bound(Rc<dyn Fn() -> T>),
}

impl<T: Clone> Clone for Reactive<T> {
    fn clone(&self) -> Self {
        match self {
            Self::Static(v) => Self::Static(v.clone()),
            Self::Bound(f) => Self::Bound(f.clone()),
        }
    }
}

impl<T: fmt::Debug> fmt::Debug for Reactive<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Static(v) => f.debug_tuple("Static").field(v).finish(),
            Self::Bound(_) => f.write_str("Bound"),
        }
    }
}

impl<T: Clone> Reactive<T> {
    /// The value now (a bound one is read, subscribing the running
    /// computation).
    pub fn get(&self) -> T {
        match self {
            Self::Static(v) => v.clone(),
            Self::Bound(f) => f(),
        }
    }
}

impl<T: 'static> Reactive<T> {
    /// This value turned into another by `f` (static stays static).
    pub fn map<U: 'static>(self, f: impl Fn(T) -> U + 'static) -> Reactive<U> {
        match self {
            Self::Static(v) => Reactive::Static(f(v)),
            Self::Bound(g) => Reactive::Bound(Rc::new(move || f(g()))),
        }
    }
}

/// What can be a [`Reactive`] `T`: a value of a type that becomes a `T`
/// (set once), a [`Signal`], [`Memo`] or [`ReadSignal`] of `T`, or a
/// closure returning what becomes a `T` (bound).
pub trait IntoReactive<T> {
    /// As a [`Reactive`].
    fn into_reactive(self) -> Reactive<T>;
}

impl<T> IntoReactive<T> for Reactive<T> {
    fn into_reactive(self) -> Reactive<T> {
        self
    }
}

impl<T: 'static, U: Into<T>, F: Fn() -> U + 'static> IntoReactive<T> for F {
    fn into_reactive(self) -> Reactive<T> {
        Reactive::Bound(Rc::new(move || self().into()))
    }
}

macro_rules! bound_handles {
    ($($handle:ident),*) => {$(
        impl<T: Clone + 'static> IntoReactive<T> for $handle<T> {
            fn into_reactive(self) -> Reactive<T> {
                Reactive::Bound(Rc::new(move || self.get()))
            }
        }
    )*};
}

bound_handles!(Signal, Memo, ReadSignal);

/// Lets values of the types after the colon be passed as static values
/// where a setter or a builder takes `impl IntoReactive<Target>` (closures,
/// signals and memos of it are already taken): an app's own types, as
/// `nsh_core::static_reactive!(Tone: Tone);`. Each type converts with
/// `Target::from`.
#[macro_export]
macro_rules! static_reactive {
    ($target:ty: $($source:ty),* $(,)?) => {$(
        impl $crate::element::IntoReactive<$target> for $source {
            fn into_reactive(self) -> $crate::element::Reactive<$target> {
                $crate::element::Reactive::Static(<$target>::from(self))
            }
        }
    )*};
}

static_reactive!(bool: bool);
static_reactive!(f32: f32);
static_reactive!(f64: f64);
static_reactive!(u32: u32);
static_reactive!(i32: i32);
static_reactive!(usize: usize);
static_reactive!(u8: u8);
static_reactive!(u64: u64);
static_reactive!(u128: u128);
static_reactive!(i8: i8);
static_reactive!(i64: i64);
static_reactive!(i128: i128);
static_reactive!(isize: isize);
static_reactive!((u32, u32): (u32, u32));
static_reactive!(String: String);
static_reactive!(std::time::Duration: std::time::Duration);

impl IntoReactive<String> for &str {
    fn into_reactive(self) -> Reactive<String> {
        Reactive::Static(self.to_owned())
    }
}

/// As `&str`: what setters that took a `&str` were given (`&url`).
impl IntoReactive<String> for &String {
    fn into_reactive(self) -> Reactive<String> {
        Reactive::Static(self.clone())
    }
}
static_reactive!(super::SharedString: super::SharedString, String, &'static str);

/// A string where an optional one goes (`.app_class("text-sm")`).
macro_rules! some_shared_string {
    ($($source:ty),*) => {$(
        impl IntoReactive<Option<super::SharedString>> for $source {
            fn into_reactive(self) -> Reactive<Option<super::SharedString>> {
                Reactive::Static(Some(self.into()))
            }
        }
    )*};
}

some_shared_string!(super::SharedString, String, &'static str);

impl<T: 'static> IntoReactive<Option<T>> for Option<T> {
    fn into_reactive(self) -> Reactive<Option<T>> {
        Reactive::Static(self)
    }
}

#[cfg(test)]
mod tests;
