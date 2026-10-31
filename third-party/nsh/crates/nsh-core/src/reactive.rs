//! The reactive graph: signals, memos, effects, owners and context, with
//! Solid 1.9's scheduling (`runUpdates`, the update and effect queues,
//! stale owners updated before their children).
//!
//! The graph is generic over a [`Host`]: what a value, a computation, an
//! equality, a cleanup and a context frame are, and how the graph is
//! reached. JS runs on it with QuickJS values and functions (`nsh-js`);
//! Rust components with Rust values and closures. Both share the algorithm
//! and its guarantees.
//!
//! Nodes live in an arena with generations; edges are two-way with back
//! indices, so unlinking is a swap-remove. Nothing here holds a reference
//! to the graph across a call into the host (a computation, an equality,
//! a cleanup, or freeing a value), which may re-enter the graph: every
//! function takes a [`Host`] handle and reaches the graph through it with
//! short borrows, and values leave their node before they are freed.

use std::rc::Rc;

/// No node (no listener, no owner).
pub const NONE: u32 = u32::MAX;
/// The owner of nodes made in a root that is never disposed: they are owned
/// by nothing.
pub const UNOWNED: u32 = u32::MAX - 1;
/// The current owner once the owner that was current is disposed while it
/// runs (a listener closing the view it belongs to, then going on): what is
/// made under it is disposed at once, since what it belongs to is gone. Its
/// slot is free to be reused, so the owner is never named by id again.
pub const DISPOSED: u32 = u32::MAX - 2;

/// Whether `owner` names a node (not [`NONE`], [`UNOWNED`] or
/// [`DISPOSED`]).
#[inline]
fn is_node(owner: u32) -> bool {
    owner < DISPOSED
}

const CLEAN: u8 = 0;
const STALE: u8 = 1;
const PENDING: u8 = 2;
/// A failed memo still needs recomputing, but is no longer queued.
const FAILED: u8 = 3;

/// Runs of computations in one flush before it counts as an infinite loop.
const MAX_RUNS: u64 = 1_000_000;

/// What a node is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// A value that is written.
    Signal,
    /// A value computed from others, cached.
    Memo,
    /// A render effect (runs as soon as possible, before user effects).
    Effect,
    /// A user effect (after the render effects).
    UserEffect,
    /// An owner that runs nothing.
    Root,
    /// A freed slot.
    Free,
}

/// When a signal or memo counts as changed.
#[derive(Debug)]
pub enum Equals<C> {
    /// The host's default ([`Host::same`]).
    Default,
    /// Always (every write notifies).
    Never,
    /// The same truthiness ([`Host::truthy`]): a condition.
    Truthiness,
    /// The host's comparison `C` ([`Host::custom_changed`]).
    Custom(C),
}

/// What a graph stores and runs, and how its functions reach it.
///
/// # Safety
///
/// [`Host::graph`] returns the graph this handle names, and the
/// implementation guarantees that the graph's functions are its only users
/// while they hold the reference (each borrow is short and ends before the
/// next call into the host).
pub unsafe trait Host: Copy + 'static {
    /// A signal's or memo's value. Owned: [`Host::dup`] makes another
    /// reference, [`Host::free`] releases one.
    type Value;
    /// A computation's function.
    type Func;
    /// A custom comparison ([`Equals::Custom`]).
    type Equals;
    /// A function run when its owner runs again or is disposed.
    type Cleanup;
    /// A context frame's content (its key and value); dropping it releases
    /// them.
    type Context;
    /// The host's own state, kept in the graph ([`Graph::data`]).
    type Data;

    /// The graph.
    ///
    /// # Safety
    ///
    /// The caller holds no other reference to the graph.
    unsafe fn graph<'a>(self) -> &'a mut Graph<Self>;
    /// The value of a node that has none (JS: `undefined`).
    fn empty() -> Self::Value;
    /// Another reference to `v`.
    fn dup(self, v: &Self::Value) -> Self::Value;
    /// Releases `v` (may re-enter the graph).
    fn free(self, v: Self::Value);
    /// Another reference to `f`.
    fn dup_func(self, f: &Self::Func) -> Self::Func;
    /// Releases `f`.
    fn free_func(self, f: Self::Func);
    /// Another reference to `e`.
    fn dup_equals(self, e: &Self::Equals) -> Self::Equals;
    /// Releases `e`.
    fn free_equals(self, e: Self::Equals);
    /// Runs computation `f` with its previous value (owned): its next
    /// value, or `None` when it failed (the host keeps the error).
    fn call(self, f: &Self::Func, prev: Self::Value) -> Option<Self::Value>;
    /// Whether `a` and `b` are the same under [`Equals::Default`] (runs no
    /// user code).
    fn same(self, a: &Self::Value, b: &Self::Value) -> bool;
    /// `v`'s truthiness, for [`Equals::Truthiness`] (runs no user code).
    fn truthy(self, v: &Self::Value) -> bool;
    /// Whether `next` counts as a change from `prev` (owned) under `e`.
    fn custom_changed(self, e: &Self::Equals, prev: Self::Value, next: &Self::Value) -> bool;
    /// Runs and releases cleanup `f`.
    fn run_cleanup(self, f: Self::Cleanup);
    /// Releases cleanup `f` without running it (a teardown).
    fn free_cleanup(self, f: Self::Cleanup);
    /// A flush ran away (an effect keeps changing what it reads): keep the
    /// error to report.
    fn runaway(self);
}

/// A context frame set by a provider, and the frame it shadows.
pub struct Frame<H: Host> {
    /// The frame it shadows.
    pub parent: Option<Rc<Frame<H>>>,
    /// Its key and value.
    pub data: H::Context,
}

struct Node<H: Host> {
    kind: Kind,
    /// Bumped when the slot is reused: handles of the old node go stale.
    generation: u32,
    state: u8,
    value: H::Value,
    func: Option<H::Func>,
    equals: Equals<H::Equals>,
    /// The exec round of the last run (`None`: never ran).
    updated_at: Option<u64>,
    /// (source, its index in the source's observers)
    sources: Vec<(u32, u32)>,
    /// (observer, its index in the observer's sources)
    observers: Vec<(u32, u32)>,
    /// The owner (for a root, the one it was made under: context and
    /// `runTop` look through it, but it does not own the root).
    owner: u32,
    owned: Vec<u32>,
    cleanups: Vec<H::Cleanup>,
    context: Option<Rc<Frame<H>>>,
    /// Something outside the graph names the node (a JS object, a Rust
    /// handle): its slot is freed when that goes ([`Graph::drop_handle`]).
    handle: bool,
    /// Disposed: runs no more (a memo keeps its value for its handle).
    disposed: bool,
}

impl<H: Host> Node<H> {
    fn new(kind: Kind, generation: u32) -> Self {
        Node {
            kind,
            generation,
            state: CLEAN,
            value: H::empty(),
            func: None,
            equals: Equals::Default,
            updated_at: None,
            sources: Vec::new(),
            observers: Vec::new(),
            owner: NONE,
            owned: Vec::new(),
            cleanups: Vec::new(),
            context: None,
            handle: false,
            disposed: false,
        }
    }

    fn is_computation(&self) -> bool {
        matches!(self.kind, Kind::Memo | Kind::Effect | Kind::UserEffect)
    }
}

/// What a freed node held, released by [`Held::free`] once the graph is no
/// longer borrowed.
#[must_use]
pub struct Held<H: Host> {
    value: H::Value,
    func: Option<H::Func>,
    equals: Option<H::Equals>,
    context: Option<Rc<Frame<H>>>,
}

impl<H: Host> Held<H> {
    /// Releases what the node held.
    pub fn free(self, h: H) {
        h.free(self.value);
        if let Some(f) = self.func {
            h.free_func(f);
        }
        if let Some(e) = self.equals {
            h.free_equals(e);
        }
        drop(self.context);
    }
}

/// The owner that was current before a run ([`Graph::enter_owner`]).
#[derive(Clone, Copy, Debug)]
pub struct SavedOwner {
    id: u32,
    generation: u32,
}

/// The nodes and the scheduler's state.
pub struct Graph<H: Host> {
    nodes: Vec<Node<H>>,
    free: Vec<u32>,
    listener: u32,
    owner: u32,
    /// Solid's `Updates`: computations to run in this round (`None`: not
    /// in a round).
    updates: Option<Vec<u32>>,
    /// Solid's `Effects`.
    effects: Option<Vec<u32>>,
    exec: u64,
    runs: u64,
    /// The host's own state.
    pub data: H::Data,
}

impl<H: Host> Graph<H> {
    /// An empty graph with the host's state `data`.
    pub fn new(data: H::Data) -> Self {
        Graph {
            nodes: Vec::new(),
            free: Vec::new(),
            listener: NONE,
            owner: NONE,
            updates: None,
            effects: None,
            exec: 0,
            runs: 0,
            data,
        }
    }

    fn alloc(&mut self, kind: Kind) -> u32 {
        match self.free.pop() {
            Some(id) => {
                let generation = self.nodes[id as usize].generation.wrapping_add(1).max(1);
                self.nodes[id as usize] = Node::new(kind, generation);
                id
            }
            None => {
                self.nodes.push(Node::new(kind, 1));
                (self.nodes.len() - 1) as u32
            }
        }
    }

    /// A new signal holding `value` (owned), compared by `equals`, named by
    /// a handle (freed with [`Graph::drop_handle`]).
    pub fn signal(&mut self, value: H::Value, equals: Equals<H::Equals>) -> u32 {
        let id = self.alloc(Kind::Signal);
        let n = &mut self.nodes[id as usize];
        let old = std::mem::replace(&mut n.value, value);
        n.equals = equals;
        n.handle = true;
        // A new node's value is empty: nothing to release.
        drop(old);
        id
    }

    /// A new signal holding `value` (owned), compared by `equals`, owned by
    /// the current owner: disposed with it (with no owner, it lives as long
    /// as the graph).
    pub fn owned_signal(&mut self, value: H::Value, equals: Equals<H::Equals>) -> u32 {
        let id = self.alloc(Kind::Signal);
        let owner = self.owner;
        let n = &mut self.nodes[id as usize];
        let old = std::mem::replace(&mut n.value, value);
        n.equals = equals;
        n.owner = if is_node(owner) { owner } else { NONE };
        drop(old);
        if is_node(owner) {
            self.nodes[owner as usize].owned.push(id);
        }
        id
    }

    /// Makes a computation running `func` under the current owner, with
    /// first value `value`; it has not run yet ([`update_computation`]).
    pub fn computation(&mut self, kind: Kind, func: H::Func, value: H::Value) -> u32 {
        let id = self.alloc(kind);
        let owner = self.owner;
        let context = self.context_of(owner);
        let n = &mut self.nodes[id as usize];
        n.func = Some(func);
        let old = std::mem::replace(&mut n.value, value);
        drop(old);
        n.state = STALE;
        n.owner = if is_node(owner) { owner } else { NONE };
        n.context = context;
        if is_node(owner) {
            self.nodes[owner as usize].owned.push(id);
        }
        id
    }

    /// A new root owner under the current owner (context passes through
    /// it; the current owner does not own it).
    pub fn root(&mut self) -> u32 {
        let current = self.owner;
        let id = self.alloc(Kind::Root);
        let context = self.context_of(current);
        let n = &mut self.nodes[id as usize];
        n.owner = if current == DISPOSED { NONE } else { current };
        n.context = context;
        id
    }

    /// The context frames owner `owner` sees, innermost first (none for
    /// [`NONE`], [`UNOWNED`] and [`DISPOSED`]).
    pub fn context_of(&self, owner: u32) -> Option<Rc<Frame<H>>> {
        if !is_node(owner) {
            return None;
        }
        self.nodes[owner as usize].context.clone()
    }

    /// The context frames the current owner sees, innermost first.
    pub fn context(&self) -> Option<Rc<Frame<H>>> {
        self.context_of(self.owner)
    }

    /// Sets a context frame on the current owner: it and what is made under
    /// it from now on see `data`. Returns the frame it replaced, to drop
    /// once the graph is no longer borrowed (`None` without an owner, and
    /// `data` comes back).
    pub fn provide(&mut self, data: H::Context) -> Result<Option<Rc<Frame<H>>>, H::Context> {
        let owner = self.owner;
        if !is_node(owner) {
            return Err(data);
        }
        let parent = self.nodes[owner as usize].context.clone();
        let frame = Rc::new(Frame { parent, data });
        Ok(self.nodes[owner as usize].context.replace(frame))
    }

    /// Whether handle (`id`, `generation`) still names its node; `mask`
    /// keeps the bits of the generation a handle holds.
    pub fn live(&self, id: u32, generation: u32, mask: u32) -> bool {
        self.nodes
            .get(id as usize)
            .is_some_and(|n| n.generation & mask == generation & mask && n.kind != Kind::Free)
    }

    /// The slots in use and all slots (freed ones are reused).
    pub fn slots(&self) -> (usize, usize) {
        (self.nodes.len() - self.free.len(), self.nodes.len())
    }

    /// Node `id`'s generation (for a handle).
    pub fn generation(&self, id: u32) -> u32 {
        self.nodes[id as usize].generation
    }

    /// The owner of node `id` (for a root, the one it was made under).
    pub fn parent(&self, id: u32) -> u32 {
        self.nodes[id as usize].owner
    }

    /// Node `id`'s kind.
    pub fn kind(&self, id: u32) -> Kind {
        self.nodes[id as usize].kind
    }

    /// Whether node `id` was disposed.
    pub fn disposed(&self, id: u32) -> bool {
        self.nodes[id as usize].disposed
    }

    /// Node `id`'s value (untracked; a disposed memo keeps its last one).
    pub fn value(&self, id: u32) -> &H::Value {
        &self.nodes[id as usize].value
    }

    /// Replaces node `id`'s value with `value`, without notifying: the old
    /// one, to change and write back ([`write()`]).
    pub fn replace_value(&mut self, id: u32, value: H::Value) -> H::Value {
        std::mem::replace(&mut self.nodes[id as usize].value, value)
    }

    /// Node `id`'s custom comparison, if it has one.
    pub fn custom_equals(&self, id: u32) -> Option<&H::Equals> {
        match &self.nodes[id as usize].equals {
            Equals::Custom(e) => Some(e),
            _ => None,
        }
    }

    /// Node `id`'s comparison.
    pub fn set_equals(&mut self, id: u32, equals: Equals<H::Equals>) -> Equals<H::Equals> {
        std::mem::replace(&mut self.nodes[id as usize].equals, equals)
    }

    /// Marks node `id` as named by a handle.
    pub fn set_handle(&mut self, id: u32) {
        self.nodes[id as usize].handle = true;
    }

    /// The handle of node `id` went: a signal, or a disposed computation,
    /// is freed now (what it held comes back, to free once the graph is no
    /// longer borrowed).
    pub fn drop_handle(&mut self, id: u32) -> Option<Held<H>> {
        let n = &mut self.nodes[id as usize];
        n.handle = false;
        if n.kind == Kind::Signal || n.disposed {
            self.unlink_observers(id);
            Some(self.release(id))
        } else {
            None
        }
    }

    /// The current owner.
    pub fn owner(&self) -> u32 {
        self.owner
    }

    /// Sets the current owner; returns the previous one.
    pub fn set_owner(&mut self, owner: u32) -> u32 {
        std::mem::replace(&mut self.owner, owner)
    }

    /// Makes `owner` current for a run; returns the previous owner, to put
    /// back with [`Self::leave_owner`].
    pub fn enter_owner(&mut self, owner: u32) -> SavedOwner {
        let previous = std::mem::replace(&mut self.owner, owner);
        SavedOwner {
            id: previous,
            generation: if is_node(previous) {
                self.nodes[previous as usize].generation
            } else {
                0
            },
        }
    }

    /// Puts back the owner [`Self::enter_owner`] saved: [`DISPOSED`] if it
    /// was disposed meanwhile (its slot may name another node now).
    pub fn leave_owner(&mut self, saved: SavedOwner) {
        self.owner = if is_node(saved.id) {
            let n = &self.nodes[saved.id as usize];
            if n.generation == saved.generation && !n.disposed {
                saved.id
            } else {
                DISPOSED
            }
        } else {
            saved.id
        };
    }

    /// The current listener (what reads track into).
    pub fn listener(&self) -> u32 {
        self.listener
    }

    /// Sets the current listener; returns the previous one.
    pub fn set_listener(&mut self, listener: u32) -> u32 {
        std::mem::replace(&mut self.listener, listener)
    }

    /// Whether a live owner owns what runs now.
    pub fn has_owner(&self) -> bool {
        self.is_live_owner(self.owner)
    }

    /// Whether node `id` is a live owner (not disposed).
    pub fn is_live_owner(&self, id: u32) -> bool {
        is_node(id) && !self.nodes[id as usize].disposed
    }

    /// Adds cleanup `f` to the current owner; gives it back without one
    /// (and under [`DISPOSED`], where the host runs it at once).
    pub fn on_cleanup(&mut self, f: H::Cleanup) -> Result<(), H::Cleanup> {
        if !is_node(self.owner) {
            return Err(f);
        }
        self.nodes[self.owner as usize].cleanups.push(f);
        Ok(())
    }

    /// Removes from owner `id` the first cleanup `matches` accepts, which
    /// then never runs: what it was to undo ended by itself.
    pub fn remove_cleanup(
        &mut self,
        id: u32,
        matches: impl Fn(&H::Cleanup) -> bool,
    ) -> Option<H::Cleanup> {
        if !is_node(id) {
            return None;
        }
        let cleanups = &mut self.nodes.get_mut(id as usize)?.cleanups;
        let at = cleanups.iter().position(matches)?;
        Some(cleanups.remove(at))
    }

    /// Whether a round is running (its end reports errors).
    pub fn in_round(&self) -> bool {
        self.updates.is_some()
    }

    /// Whether effects are being collected (a new user effect waits for
    /// them).
    pub fn collecting_effects(&self) -> bool {
        self.effects.is_some()
    }

    /// A round ended: the runaway count starts over.
    pub fn reset_runs(&mut self) {
        self.runs = 0;
    }

    /// Queues user effect `id` after the render effects of the round.
    pub fn queue_effect(&mut self, id: u32) {
        match &mut self.effects {
            Some(q) => q.push(id),
            None => self.effects = Some(vec![id]),
        }
    }

    fn queue_update(&mut self, id: u32) {
        match &mut self.updates {
            Some(q) => q.push(id),
            None => self.updates = Some(vec![id]),
        }
    }

    fn track(&mut self, id: u32) {
        let l = self.listener;
        if l == NONE || l == UNOWNED || self.nodes[l as usize].disposed {
            return;
        }
        // Repeated reads of the same source make one edge.
        if self.nodes[l as usize]
            .sources
            .last()
            .is_some_and(|&(s, _)| s == id)
        {
            return;
        }
        let slot = self.nodes[id as usize].observers.len() as u32;
        let back = self.nodes[l as usize].sources.len() as u32;
        self.nodes[l as usize].sources.push((id, slot));
        self.nodes[id as usize].observers.push((l, back));
    }

    fn unlink_sources(&mut self, id: u32) {
        while let Some((src, slot)) = self.nodes[id as usize].sources.pop() {
            let obs = &mut self.nodes[src as usize].observers;
            let Some(last) = obs.pop() else { continue };
            if (slot as usize) < obs.len() {
                obs[slot as usize] = last;
                self.nodes[last.0 as usize].sources[last.1 as usize].1 = slot;
            }
        }
    }

    fn unlink_observers(&mut self, id: u32) {
        while let Some((o, slot)) = self.nodes[id as usize].observers.pop() {
            let srcs = &mut self.nodes[o as usize].sources;
            let Some(last) = srcs.pop() else { continue };
            if (slot as usize) < srcs.len() {
                srcs[slot as usize] = last;
                self.nodes[last.0 as usize].observers[last.1 as usize].1 = slot;
            }
        }
    }

    /// Frees slot `id`: what it held, to be freed by the caller once no
    /// borrow of the graph is live.
    fn release(&mut self, id: u32) -> Held<H> {
        let n = &mut self.nodes[id as usize];
        let held = Held {
            value: std::mem::replace(&mut n.value, H::empty()),
            func: n.func.take(),
            equals: match std::mem::replace(&mut n.equals, Equals::Default) {
                Equals::Custom(e) => Some(e),
                _ => None,
            },
            context: n.context.take(),
        };
        n.kind = Kind::Free;
        n.handle = false;
        n.disposed = true;
        self.free.push(id);
        held
    }

    /// Solid's `markDownstream`.
    fn mark_downstream(&mut self, id: u32) {
        let mut i = 0;
        while i < self.nodes[id as usize].observers.len() {
            let o = self.nodes[id as usize].observers[i].0;
            i += 1;
            if self.nodes[o as usize].state == CLEAN && !self.nodes[o as usize].disposed {
                self.nodes[o as usize].state = PENDING;
                if self.nodes[o as usize].kind == Kind::Memo {
                    self.queue_update(o);
                } else {
                    self.queue_effect(o);
                }
                if !self.nodes[o as usize].observers.is_empty() {
                    self.mark_downstream(o);
                }
            }
        }
    }

    /// Frees every value the graph holds, for a teardown (no host code runs
    /// from here on but releasing).
    pub fn free_all(&mut self, h: H) {
        for n in &mut self.nodes {
            if n.kind == Kind::Free {
                continue;
            }
            h.free(std::mem::replace(&mut n.value, H::empty()));
            if let Some(f) = n.func.take() {
                h.free_func(f);
            }
            if let Equals::Custom(e) = std::mem::replace(&mut n.equals, Equals::Default) {
                h.free_equals(e);
            }
            for f in n.cleanups.drain(..) {
                h.free_cleanup(f);
            }
            n.context = None;
            n.kind = Kind::Free;
        }
    }
}

/// The graph of `h`, for one short borrow.
#[inline]
fn g<'a, H: Host>(h: H) -> &'a mut Graph<H> {
    // SAFETY: every borrow in this module is short and ends before the next
    // call into the host, as `Host`'s contract requires.
    unsafe { h.graph() }
}

/// Solid's `runUpdates`: runs `f`, then the queued computations and
/// effects (unless a round is running already: they join it). `init` (a
/// root, `runWithOwner`): what `f` makes runs at once rather than queued;
/// only effects wait for the end.
pub fn run_updates<H: Host, R>(h: H, init: bool, f: impl FnOnce() -> R) -> R {
    let Some(wait) = begin_updates(h, init) else {
        return f();
    };
    let r = f();
    end_updates(h, wait);
    r
}

/// The start of a [`run_updates`] round, out of line so the generic
/// function is little more than its closure (one per closure, hundreds in
/// all): `None` inside a running round, else whether the effects wait for
/// an outer round.
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn begin_updates<H: Host>(h: H, init: bool) -> Option<bool> {
    let graph = g(h);
    if graph.updates.is_some() {
        return None;
    }
    if !init {
        graph.updates = Some(Vec::new());
    }
    let wait = if graph.effects.is_some() {
        true
    } else {
        graph.effects = Some(Vec::new());
        false
    };
    graph.exec += 1;
    Some(wait)
}

/// The end of a [`run_updates`] round.
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn end_updates<H: Host>(h: H, wait: bool) {
    complete_updates(h, wait);
    if !wait {
        // The round ended: the runaway count starts over. The JS host also
        // resets it when a call returns; Rust components make no such call.
        g(h).reset_runs();
    }
}

/// Solid's `completeUpdates`. Solid runs the effects in a new round, whose
/// end runs the effects that round queued, and so on: here that recursion
/// is a loop (the same order), so an effect that keeps changing what it
/// reads ends in the runaway error, not in a stack overflow.
fn complete_updates<H: Host>(h: H, wait: bool) {
    run_queued_updates(h);
    if wait {
        return;
    }
    loop {
        let graph = g(h);
        let effects = graph.effects.take().unwrap_or_default();
        if effects.is_empty() {
            break;
        }
        // `run_updates(false, || run_effects(..))` at the end of a round:
        // no round runs, and the effects were taken.
        graph.updates = Some(Vec::new());
        graph.effects = Some(Vec::new());
        graph.exec += 1;
        run_effects(h, &effects);
        run_queued_updates(h);
    }
}

/// Runs the computations queued in the round, and ends it.
fn run_queued_updates<H: Host>(h: H) {
    let mut i = 0;
    while let Some(next) = g(h).updates.as_ref().and_then(|q| q.get(i).copied()) {
        i += 1;
        if !count_run(h) {
            break;
        }
        run_top(h, next);
    }
    g(h).updates = None;
}

/// Counts a run; false (with an error) once a flush runs away.
fn count_run<H: Host>(h: H) -> bool {
    let graph = g(h);
    graph.runs += 1;
    if graph.runs <= MAX_RUNS {
        return true;
    }
    graph.updates = Some(Vec::new());
    graph.effects = None;
    h.runaway();
    false
}

/// Solid's `runEffects` with user effects after the render effects.
fn run_effects<H: Host>(h: H, effects: &[u32]) {
    for user in [false, true] {
        for &e in effects {
            let kind = g(h).nodes[e as usize].kind;
            if (kind == Kind::UserEffect) == user && count_run(h) {
                run_top(h, e);
            }
        }
    }
}

/// Solid's `runTop`: updates the node, its stale owners first.
fn run_top<H: Host>(h: H, id: u32) {
    let graph = g(h);
    let node = &graph.nodes[id as usize];
    if node.state == CLEAN || node.disposed || !node.is_computation() {
        return;
    }
    if node.state == PENDING {
        return look_upstream(h, id, NONE);
    }
    let exec = graph.exec;
    let mut ancestors = vec![id];
    let mut at = node.owner;
    while is_node(at) {
        let n = &graph.nodes[at as usize];
        if n.updated_at.is_some_and(|t| t >= exec) {
            break;
        }
        if n.state != CLEAN && n.is_computation() {
            ancestors.push(at);
        }
        at = n.owner;
    }
    for &node in ancestors.iter().rev() {
        let n = &g(h).nodes[node as usize];
        if n.disposed {
            continue;
        }
        if n.state == STALE || n.state == FAILED {
            update_computation(h, node);
        } else if n.state == PENDING {
            let updates = g(h).updates.take();
            run_updates(h, false, || look_upstream(h, node, ancestors[0]));
            g(h).updates = updates;
        }
    }
}

/// Solid's `lookUpstream`: brings the stale memos `id` reads up to date.
fn look_upstream<H: Host>(h: H, id: u32, ignore: u32) {
    g(h).nodes[id as usize].state = CLEAN;
    let mut i = 0;
    loop {
        let graph = g(h);
        let Some(&(source, _)) = graph.nodes[id as usize].sources.get(i) else {
            break;
        };
        i += 1;
        let s = &graph.nodes[source as usize];
        if s.kind != Kind::Memo {
            continue;
        }
        if s.state == STALE || s.state == FAILED {
            if source != ignore && s.updated_at.is_none_or(|t| t < graph.exec) {
                run_top(h, source);
            }
        } else if s.state == PENDING {
            look_upstream(h, source, ignore);
        }
    }
}

/// Solid's `updateComputation`: cleans the node and runs it again.
pub fn update_computation<H: Host>(h: H, id: u32) {
    let graph = g(h);
    if graph.nodes[id as usize].disposed || graph.nodes[id as usize].kind == Kind::Free {
        return;
    }
    clean_node(h, id);
    let exec = g(h).exec;
    run_computation(h, id, exec);
}

/// Solid's `runComputation`.
fn run_computation<H: Host>(h: H, id: u32, time: u64) {
    let graph = g(h);
    let n = &graph.nodes[id as usize];
    let Some(func) = n.func.as_ref().map(|f| h.dup_func(f)) else {
        return;
    };
    let prev = h.dup(&n.value);
    let listener = std::mem::replace(&mut graph.listener, id);
    let owner = graph.enter_owner(id);
    let result = h.call(&func, prev);
    h.free_func(func);
    let graph = g(h);
    graph.listener = listener;
    graph.leave_owner(owner);
    let Some(next) = result else {
        let n = &mut graph.nodes[id as usize];
        if n.kind == Kind::Memo {
            n.state = FAILED;
            let owned = std::mem::take(&mut n.owned);
            for c in owned {
                dispose(h, c);
            }
        }
        g(h).nodes[id as usize].updated_at = Some(time + 1);
        return;
    };
    let n = &mut graph.nodes[id as usize];
    if n.disposed {
        // Disposed while running (its owner re-ran).
        h.free(next);
        return;
    }
    if n.updated_at.is_none_or(|t| t <= time) {
        let notify = n.updated_at.is_some() && n.kind == Kind::Memo;
        n.updated_at = Some(time);
        if notify {
            write(h, id, next);
        } else {
            let old = std::mem::replace(&mut n.value, next);
            h.free(old);
        }
    } else {
        h.free(next);
    }
}

/// Whether `next` counts as a change from node `id`'s value.
fn changed<H: Host>(h: H, id: u32, next: &H::Value) -> bool {
    let n = &g(h).nodes[id as usize];
    match &n.equals {
        Equals::Default => !h.same(&n.value, next),
        Equals::Never => true,
        Equals::Truthiness => h.truthy(&n.value) != h.truthy(next),
        Equals::Custom(e) => {
            let (e, prev) = (h.dup_equals(e), h.dup(&n.value));
            let changed = h.custom_changed(&e, prev, next);
            h.free_equals(e);
            changed
        }
    }
}

/// Solid's `writeSignal`: takes `next` (owned).
pub fn write<H: Host>(h: H, id: u32, next: H::Value) {
    if !changed(h, id, &next) {
        h.free(next);
        return;
    }
    let graph = g(h);
    let old = std::mem::replace(&mut graph.nodes[id as usize].value, next);
    let observed = !graph.nodes[id as usize].observers.is_empty();
    h.free(old);
    if !observed {
        return;
    }
    run_updates(h, false, || {
        let graph = g(h);
        let mut i = 0;
        while i < graph.nodes[id as usize].observers.len() {
            let o = graph.nodes[id as usize].observers[i].0;
            i += 1;
            if graph.nodes[o as usize].disposed {
                continue;
            }
            if graph.nodes[o as usize].state == CLEAN || graph.nodes[o as usize].state == FAILED {
                if graph.nodes[o as usize].kind == Kind::Memo {
                    graph.queue_update(o);
                } else {
                    graph.queue_effect(o);
                }
                if !graph.nodes[o as usize].observers.is_empty() {
                    graph.mark_downstream(o);
                }
            }
            graph.nodes[o as usize].state = STALE;
        }
    });
}

/// Solid's `readSignal`: brings a memo up to date, tracks, and returns
/// another reference to the value.
pub fn read<H: Host>(h: H, id: u32) -> H::Value {
    let n = &g(h).nodes[id as usize];
    if n.kind == Kind::Memo && !n.disposed && n.state != CLEAN {
        if n.state == STALE || n.state == FAILED {
            update_computation(h, id);
        } else {
            let updates = g(h).updates.take();
            run_updates(h, false, || look_upstream(h, id, NONE));
            g(h).updates = updates;
        }
    }
    let graph = g(h);
    if !graph.nodes[id as usize].disposed {
        graph.track(id);
    }
    h.dup(&graph.nodes[id as usize].value)
}

/// Solid's `cleanNode`: unlinks the node's sources, disposes what it owns
/// and runs its cleanups.
fn clean_node<H: Host>(h: H, id: u32) {
    g(h).unlink_sources(id);
    while let Some(c) = g(h).nodes[id as usize].owned.pop() {
        dispose(h, c);
    }
    while let Some(f) = g(h).nodes[id as usize].cleanups.pop() {
        h.run_cleanup(f);
    }
    g(h).nodes[id as usize].state = CLEAN;
}

/// Disposes node `id`: cleans it, unlinks it and frees it (a node named by
/// a handle keeps its value until the handle goes).
pub fn dispose<H: Host>(h: H, id: u32) {
    if !is_node(id) || g(h).nodes[id as usize].disposed {
        return;
    }
    // Code running under it goes on under no owner it could reuse the slot
    // of: what it makes from now on goes at once (its cleanups' too).
    if g(h).owner == id {
        g(h).owner = DISPOSED;
    }
    clean_node(h, id);
    let graph = g(h);
    graph.unlink_observers(id);
    let n = &mut graph.nodes[id as usize];
    n.disposed = true;
    n.state = CLEAN;
    if n.handle {
        let func = n.func.take();
        let context = n.context.take();
        if let Some(f) = func {
            h.free_func(f);
        }
        drop(context);
    } else {
        graph.release(id).free(h);
    }
}

/// Makes a memo of `func` under the current owner and runs it at once
/// (inside a round too: what is made while rendering reads it right away,
/// as in Solid without transitions). With `handle`, something outside the
/// graph names it and it keeps its value after it is disposed, until
/// [`Graph::drop_handle`]; without, it is freed when disposed.
pub fn memo<H: Host>(
    h: H,
    func: H::Func,
    value: H::Value,
    equals: Equals<H::Equals>,
    handle: bool,
) -> u32 {
    let graph = g(h);
    let gone = graph.owner == DISPOSED;
    let id = graph.computation(Kind::Memo, func, value);
    graph.nodes[id as usize].equals = equals;
    graph.nodes[id as usize].handle = handle;
    if gone {
        dispose(h, id);
    } else {
        update_computation(h, id);
    }
    id
}

/// Makes an effect of `func` under the current owner. A render effect runs
/// at once (inside a round too); a user effect after the render effects of
/// the round, or now outside one.
pub fn effect<H: Host>(h: H, kind: Kind, func: H::Func, value: H::Value) -> u32 {
    debug_assert!(matches!(kind, Kind::Effect | Kind::UserEffect));
    let graph = g(h);
    let gone = graph.owner == DISPOSED;
    let id = graph.computation(kind, func, value);
    if gone {
        dispose(h, id);
    } else if kind == Kind::UserEffect && graph.effects.is_some() {
        graph.queue_effect(id);
    } else {
        update_computation(h, id);
    }
    id
}

/// Runs `f` with no listener (untracked).
pub fn untracked<H: Host, R>(h: H, f: impl FnOnce() -> R) -> R {
    let listener = swap_listener(h, NONE);
    let r = f();
    swap_listener(h, listener);
    r
}

/// Makes `listener` the graph's, returning the previous one (out of line
/// for the generic functions around closures).
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn swap_listener<H: Host>(h: H, listener: u32) -> u32 {
    g(h).set_listener(listener)
}

/// Runs `f` as one batch: its writes apply together at the end.
pub fn batch<H: Host, R>(h: H, f: impl FnOnce() -> R) -> R {
    run_updates(h, false, f)
}

/// Runs `f` under owner `owner` with no listener, as a root runs (what `f`
/// makes runs at once).
pub fn with_owner<H: Host, R>(h: H, owner: u32, f: impl FnOnce() -> R) -> R {
    let previous = enter_owner_untracked(h, owner);
    let r = run_updates(h, true, f);
    leave_owner_untracked(h, previous);
    r
}

/// The start of [`with_owner`]: `owner` current, no listener; what was
/// before, for [`leave_owner_untracked`].
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn enter_owner_untracked<H: Host>(h: H, owner: u32) -> (SavedOwner, u32) {
    let graph = g(h);
    let previous_owner = graph.enter_owner(owner);
    let previous_listener = graph.set_listener(NONE);
    (previous_owner, previous_listener)
}

/// The end of [`with_owner`]: the owner and listener before it back.
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn leave_owner_untracked<H: Host>(h: H, (previous_owner, previous_listener): (SavedOwner, u32)) {
    let graph = g(h);
    graph.leave_owner(previous_owner);
    graph.listener = previous_listener;
}

/// Runs `f` in a new root owner under the current one (context passes
/// through it); returns the root and `f`'s result. The root is disposed
/// with [`dispose_owner`].
///
/// Under [`DISPOSED`] there is no root: `f` runs there too (what it makes
/// goes at once) and the root is `DISPOSED`, which disposing ignores.
pub fn with_root<H: Host, R>(h: H, f: impl FnOnce() -> R) -> (u32, R) {
    let id = new_root(h);
    (id, with_owner(h, id, f))
}

/// The root [`with_root`] runs under: a new one, or [`DISPOSED`].
#[cfg_attr(target_arch = "wasm32", inline(never))]
fn new_root<H: Host>(h: H) -> u32 {
    let graph = g(h);
    if graph.owner == DISPOSED {
        DISPOSED
    } else {
        graph.root()
    }
}

/// [`with_root`] as if run under `owner`: what is made later (a list's
/// rows) sees that owner's context.
pub fn with_root_under<H: Host, R>(h: H, owner: u32, f: impl FnOnce() -> R) -> (u32, R) {
    let graph = g(h);
    let live = graph.is_live_owner(owner);
    let previous = graph.enter_owner(if live { owner } else { NONE });
    let r = with_root(h, f);
    g(h).leave_owner(previous);
    r
}

/// Disposes owner `id`, untracked.
pub fn dispose_owner<H: Host>(h: H, id: u32) {
    untracked(h, || dispose(h, id));
}

#[cfg(test)]
mod tests;
