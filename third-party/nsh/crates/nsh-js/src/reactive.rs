//! The reactive graph JS runs on: the generic graph of
//! [`nsh_core::reactive`] with QuickJS values and functions, and the JS
//! objects and natives over it.
//!
//! Reading a signal or a memo is a call of a native callable object (a few
//! nanoseconds, cheaper than calling a JS function); writing one marks its
//! dependants and runs the effects in Rust; only the user's closures run in
//! the interpreter. The scheduling is Solid 1.9's (`nsh_core::reactive`),
//! which the runtime and apps rely on.
//!
//! Lifetimes: a signal lives as long as its JS object (the object's GC mark
//! reports the value, so cycles through it are collected); memos and
//! effects belong to the owner they were made under and are disposed with
//! it; a memo's object keeps reading its last value after that. Nothing
//! here holds a Rust reference across a call into JS (which may re-enter)
//! or across freeing a JS value (which may finalize a signal or memo object,
//! whose finalizer updates the graph): the graph is reached through the
//! context's opaque pointer, every access is short, and values leave their
//! node before they are freed.

use std::{
    ffi::{CStr, c_int, c_void},
    ptr,
};

#[cfg(test)]
use nsh_core::reactive::UNOWNED;
use nsh_core::reactive::{self as r, Equals, Kind};
#[cfg(test)]
use rquickjs::Ctx;
use rquickjs::qjs;

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The graph's host: QuickJS values, functions as computations, equality
/// functions and cleanups, reached through the context's state.
#[derive(Clone, Copy)]
pub(crate) struct Js(pub(crate) *mut JsContext);

/// The graph JS runs on.
pub(crate) type Graph = r::Graph<Js>;

/// What the JS host keeps in the graph.
pub(crate) struct JsData {
    cx: *mut JsContext,
    classes: Classes,
    /// The first exception of a round, thrown when the round ends.
    error: Option<JsValue>,
    /// The context key of error boundaries (`ErrorBoundary`): its value is
    /// the boundary's signal of the error it shows (owned).
    boundary_key: JsValue,
    /// Exceptions error boundaries caught, with the boundary's signal
    /// (owned): delivered once no computation runs ([`finish`]), as a
    /// boundary shows its fallback by running again.
    caught: Vec<(JsValue, JsValue)>,
    /// How many computations run now (nested).
    running: u32,
}

/// A context value set by a provider.
pub(crate) struct JsFrame {
    key: JsValue,
    value: JsValue,
    cx: *mut JsContext,
}

impl Drop for JsFrame {
    fn drop(&mut self) {
        // SAFETY: frames only live in a graph, which is torn down before
        // its context.
        unsafe {
            qjs::JS_FreeValue(self.cx, self.key);
            qjs::JS_FreeValue(self.cx, self.value);
        }
    }
}

// SAFETY: the graph is reached through the context's state, and the
// generic graph and the natives here take only short borrows of it.
unsafe impl r::Host for Js {
    type Value = JsValue;
    type Func = JsValue;
    type Equals = JsValue;
    type Cleanup = JsValue;
    type Context = JsFrame;
    type Data = JsData;

    #[inline]
    unsafe fn graph<'a>(self) -> &'a mut Graph {
        // SAFETY: as the caller promises; a projection of the state's field.
        unsafe { &mut (*crate::state::state(self.0)).graph }
    }

    #[inline]
    fn empty() -> JsValue {
        UNDEFINED
    }

    #[inline]
    fn dup(self, v: &JsValue) -> JsValue {
        // SAFETY: a live value.
        unsafe { qjs::JS_DupValue(self.0, *v) }
    }

    #[inline]
    fn free(self, v: JsValue) {
        // SAFETY: an owned value.
        unsafe { qjs::JS_FreeValue(self.0, v) }
    }

    #[inline]
    fn dup_func(self, f: &JsValue) -> JsValue {
        self.dup(f)
    }

    #[inline]
    fn free_func(self, f: JsValue) {
        self.free(f)
    }

    fn dup_equals(self, e: &JsValue) -> JsValue {
        self.dup(e)
    }

    fn free_equals(self, e: JsValue) {
        self.free(e)
    }

    fn call(self, f: &JsValue, prev: JsValue) -> Option<JsValue> {
        let cx = self.0;
        let mut args = [prev];
        // SAFETY: short borrows of the graph around the call.
        unsafe { graph(cx) }.data.running += 1;
        // SAFETY: `f` and `args` are live values; the call may re-enter the
        // graph, which holds no reference here.
        let r = unsafe { qjs::JS_Call(cx, *f, UNDEFINED, 1, args.as_mut_ptr()) };
        unsafe { graph(cx) }.data.running -= 1;
        self.free(args[0]);
        // SAFETY: inline tag check.
        if unsafe { qjs::JS_IsException(r) } {
            // The computation is still the current owner: what fails under
            // an error boundary goes to it.
            let exception = unsafe { qjs::JS_GetException(cx) };
            match lookup(cx, unsafe { graph(cx) }.data.boundary_key) {
                Some(boundary) => catch(cx, boundary, exception),
                None => keep_error(cx, exception),
            }
            None
        } else {
            Some(r)
        }
    }

    #[inline]
    fn same(self, a: &JsValue, b: &JsValue) -> bool {
        // SAFETY: live values; strict equality runs no JS.
        unsafe { qjs::JS_IsStrictEqual(self.0, *a, *b) }
    }

    #[inline]
    fn truthy(self, v: &JsValue) -> bool {
        // SAFETY: a live value; truthiness runs no JS.
        unsafe { qjs::JS_ToBool(self.0, *v) == 1 }
    }

    fn custom_changed(self, e: &JsValue, prev: JsValue, next: &JsValue) -> bool {
        let mut args = [prev, self.dup(next)];
        let r = call(self.0, *e, &mut args);
        self.free(args[0]);
        self.free(args[1]);
        match r {
            Ok(same) => {
                let changed = !self.truthy(&same);
                self.free(same);
                changed
            }
            // A comparison that throws counts as a change.
            Err(()) => true,
        }
    }

    fn run_cleanup(self, f: JsValue) {
        if let Ok(r) = call(self.0, f, &mut []) {
            self.free(r);
        }
        self.free(f);
    }

    fn free_cleanup(self, f: JsValue) {
        self.free(f);
    }

    fn runaway(self) {
        let message = c"potential infinite loop: an effect keeps changing what it reads";
        // SAFETY: a new error object; a short borrow of the graph.
        unsafe {
            let error = qjs::JS_NewError(self.0);
            let bytes = message.to_bytes();
            let text = qjs::JS_NewStringLen(self.0, bytes.as_ptr().cast(), bytes.len() as _);
            qjs::JS_SetPropertyStr(self.0, error, c"message".as_ptr(), text);
            let g = graph(self.0);
            if g.data.error.is_none() {
                g.data.error = Some(error);
            } else {
                qjs::JS_FreeValue(self.0, error);
            }
        }
    }
}

/// The class ids of the graph's JS objects.
#[derive(Clone, Copy)]
struct Classes {
    signal: qjs::JSClassID,
    setter: qjs::JSClassID,
    memo: qjs::JSClassID,
    resource: qjs::JSClassID,
}

/// The graph of `cx`.
///
/// # Safety
///
/// `cx` has a state ([`crate::state::install`]), and the caller holds no
/// other reference to the graph.
#[inline]
pub(crate) unsafe fn graph<'a>(cx: *mut JsContext) -> &'a mut Graph {
    // SAFETY: as the caller promises.
    unsafe { r::Host::graph(Js(cx)) }
}

/// The graph of runtime `rt` (finalizers, GC marks), unless it is being
/// torn down.
fn graph_of_runtime<'a>(rt: *mut qjs::JSRuntime) -> Option<&'a mut Graph> {
    // SAFETY: a registered state is live; finalizers and marks run during
    // GC, when natives hold no reference to the graph.
    crate::state::of_runtime(rt).map(|p| unsafe { &mut (*p).graph })
}

/// Packs a node id and its generation into an opaque pointer (never null:
/// generations start at 1).
#[cfg(target_pointer_width = "64")]
fn pack(id: u32, generation: u32) -> *mut c_void {
    (((generation as u64) << 32) | id as u64) as usize as *mut c_void
}

#[cfg(target_pointer_width = "64")]
fn unpack(p: *mut c_void) -> (u32, u32) {
    let v = p as usize as u64;
    (v as u32, (v >> 32) as u32)
}

/// The bits of a generation an opaque pointer keeps.
#[cfg(target_pointer_width = "64")]
const GENERATION_MASK: u32 = u32::MAX;

/// 32-bit pointers (WebAssembly) hold 20 bits of id and the low 11 bits of
/// the generation, under a set top bit (never null). Stale handles are
/// still caught unless a node was reused a multiple of 2048 times.
#[cfg(target_pointer_width = "32")]
const GENERATION_MASK: u32 = 0x7ff;

#[cfg(target_pointer_width = "32")]
fn pack(id: u32, generation: u32) -> *mut c_void {
    debug_assert!(id < 1 << 20, "node ids fit in 20 bits");
    ((1 << 31) | ((generation & GENERATION_MASK) << 20) | (id & 0xf_ffff)) as usize as *mut c_void
}

#[cfg(target_pointer_width = "32")]
fn unpack(p: *mut c_void) -> (u32, u32) {
    let v = p as usize as u32;
    (v & 0xf_ffff, (v >> 20) & GENERATION_MASK)
}

/// An exception of a JS call: kept as the round's error (the first wins).
fn take_exception(cx: *mut JsContext) {
    // SAFETY: an exception is pending.
    let exception = unsafe { qjs::JS_GetException(cx) };
    keep_error(cx, exception);
}

/// Keeps `exception` (owned) as the round's error, unless one is kept.
fn keep_error(cx: *mut JsContext, exception: JsValue) {
    // SAFETY: no other reference to the graph is live here.
    let g = unsafe { graph(cx) };
    if g.data.error.is_none() {
        g.data.error = Some(exception);
    } else {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, exception) };
    }
}

/// Error boundary `boundary` (its signal, owned) caught `exception`
/// (owned): it shows it once no computation runs. The first a boundary
/// catches wins: the fallback replaces what failed after.
fn catch(cx: *mut JsContext, boundary: JsValue, exception: JsValue) {
    // SAFETY: a short borrow; strict equality runs no JS.
    let g = unsafe { graph(cx) };
    let known = g
        .data
        .caught
        .iter()
        .any(|&(b, _)| unsafe { qjs::JS_IsStrictEqual(cx, b, boundary) });
    if known {
        // SAFETY: ours.
        unsafe {
            qjs::JS_FreeValue(cx, boundary);
            qjs::JS_FreeValue(cx, exception);
        }
    } else {
        g.data.caught.push((boundary, exception));
    }
}

/// The error boundary (its signal, owned) of what owner `owner` (from
/// [`owner_handle`]) runs, if it is still live and under one.
pub(crate) fn boundary_of(cx: *mut JsContext, (owner, generation): (u32, u32)) -> Option<JsValue> {
    // SAFETY: short borrows.
    let g = unsafe { graph(cx) };
    if !g.is_live_owner(owner) || !g.live(owner, generation, u32::MAX) {
        return None;
    }
    let key = g.data.boundary_key;
    find(cx, g.context_of(owner), key)
}

/// The current owner and its generation, for [`boundary_of`] later
/// (`NONE` without one).
pub(crate) fn owner_handle(cx: *mut JsContext) -> (u32, u32) {
    // SAFETY: a short borrow.
    let g = unsafe { graph(cx) };
    let owner = g.owner();
    if g.is_live_owner(owner) {
        (owner, g.generation(owner))
    } else {
        (r::NONE, 0)
    }
}

/// Hands the pending exception to the error boundary of owner `owner`
/// (from [`owner_handle`]): whether one caught it (else it stays pending).
/// A listener's failure goes there, as one of a computation does.
pub(crate) fn catch_pending(cx: *mut JsContext, owner: (u32, u32)) -> bool {
    let Some(boundary) = boundary_of(cx, owner) else {
        return false;
    };
    // SAFETY: an exception is pending.
    let exception = unsafe { qjs::JS_GetException(cx) };
    catch(cx, boundary, exception);
    let r = finish(cx, UNDEFINED);
    // SAFETY: inline tag check; what the delivery threw stays pending.
    !unsafe { qjs::JS_IsException(r) }
}

/// Hands the pending exception to error boundary `boundary` (its signal,
/// borrowed).
pub(crate) fn catch_pending_at(cx: *mut JsContext, boundary: JsValue) {
    // SAFETY: an exception is pending; a dup for the list.
    let (exception, boundary) =
        unsafe { (qjs::JS_GetException(cx), qjs::JS_DupValue(cx, boundary)) };
    catch(cx, boundary, exception);
}

/// The context key of error boundaries (borrowed).
pub(crate) fn boundary_key(cx: *mut JsContext) -> JsValue {
    unsafe { graph(cx) }.data.boundary_key
}

/// Shows what error boundaries caught: each boundary's signal is set to
/// `[error]`, which runs it again (its fallback may fail in turn, for the
/// boundary above).
fn deliver_caught(cx: *mut JsContext) {
    loop {
        // SAFETY: a short borrow.
        let caught = std::mem::take(&mut unsafe { graph(cx) }.data.caught);
        if caught.is_empty() {
            return;
        }
        for (boundary, error) in caught {
            let mut items = [error];
            // SAFETY: the array takes the error.
            let wrapped = unsafe { qjs::JS_NewArrayFrom(cx, 1, items.as_mut_ptr()) };
            set_signal(cx, boundary, wrapped);
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, boundary) };
        }
    }
}

/// Calls `f` with `args`, keeping an exception as the round's error.
/// `Err` when it threw.
fn call(cx: *mut JsContext, f: JsValue, args: &mut [JsValue]) -> Result<JsValue, ()> {
    // SAFETY: `f` and `args` are live values; the call may re-enter the
    // graph, which holds no reference here.
    let r = unsafe { qjs::JS_Call(cx, f, UNDEFINED, args.len() as c_int, args.as_mut_ptr()) };
    // SAFETY: inline tag check.
    if unsafe { qjs::JS_IsException(r) } {
        take_exception(cx);
        Err(())
    } else {
        Ok(r)
    }
}

// --- The JS objects -------------------------------------------------------

/// The node a signal / setter / memo object names, if it is still live.
unsafe fn node_of(cx: *mut JsContext, obj: JsValue, class: qjs::JSClassID) -> Option<u32> {
    // SAFETY: an object of `class` holds a packed handle.
    let p = unsafe { qjs::JS_GetOpaque(obj, class) };
    if p.is_null() {
        return None;
    }
    let (id, generation) = unpack(p);
    unsafe { graph(cx) }
        .live(id, generation, GENERATION_MASK)
        .then_some(id)
}

unsafe extern "C" fn signal_call(
    cx: *mut JsContext,
    func: JsValue,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _flags: c_int,
) -> JsValue {
    let classes = unsafe { graph(cx) }.data.classes;
    let id =
        unsafe { node_of(cx, func, classes.signal).or_else(|| node_of(cx, func, classes.memo)) };
    match id {
        Some(id) => {
            let value = r::read(Js(cx), id);
            finish(cx, value)
        }
        None => UNDEFINED,
    }
}

unsafe extern "C" fn setter_call(
    cx: *mut JsContext,
    func: JsValue,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _flags: c_int,
) -> JsValue {
    let class = unsafe { graph(cx) }.data.classes.setter;
    let Some(id) = (unsafe { node_of(cx, func, class) }) else {
        return UNDEFINED;
    };
    let mut value = if argc > 0 {
        unsafe { qjs::JS_DupValue(cx, *argv) }
    } else {
        UNDEFINED
    };
    // An updater gets the previous value.
    if unsafe { qjs::JS_IsFunction(cx, value) } {
        let prev = unsafe { qjs::JS_DupValue(cx, *graph(cx).value(id)) };
        let mut args = [prev];
        let r = unsafe { qjs::JS_Call(cx, value, UNDEFINED, 1, args.as_mut_ptr()) };
        unsafe {
            qjs::JS_FreeValue(cx, args[0]);
            qjs::JS_FreeValue(cx, value);
        }
        if unsafe { qjs::JS_IsException(r) } {
            return r;
        }
        value = r;
    }
    let returned = unsafe { qjs::JS_DupValue(cx, value) };
    r::write(Js(cx), id, value);
    finish(cx, returned)
}

/// Returns `value`, or throws the error a round kept.
fn finish(cx: *mut JsContext, value: JsValue) -> JsValue {
    // SAFETY: short borrow.
    let g = unsafe { graph(cx) };
    if g.in_round() {
        // Still in a round: its end throws.
        return value;
    }
    g.reset_runs();
    if g.data.running == 0 && !g.data.caught.is_empty() {
        deliver_caught(cx);
    }
    // SAFETY: short borrow.
    let g = unsafe { graph(cx) };
    match g.data.error.take() {
        Some(error) => unsafe {
            qjs::JS_FreeValue(cx, value);
            qjs::JS_Throw(cx, error)
        },
        None => value,
    }
}

unsafe extern "C" fn finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    let Some(g) = graph_of_runtime(rt) else {
        return;
    };
    let class = unsafe { qjs::JS_GetClassID(obj) };
    if class == g.data.classes.setter {
        return;
    }
    let p = unsafe { qjs::JS_GetOpaque(obj, class) };
    if p.is_null() {
        return;
    }
    let (id, generation) = unpack(p);
    if !g.live(id, generation, GENERATION_MASK) {
        return;
    }
    let cx = g.data.cx;
    // Freed now, as QuickJS's cycle collection expects of finalizers.
    if let Some(held) = g.drop_handle(id) {
        held.free(Js(cx));
    }
}

unsafe extern "C" fn gc_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    let Some(g) = graph_of_runtime(rt) else {
        return;
    };
    let class = unsafe { qjs::JS_GetClassID(obj) };
    let p = unsafe { qjs::JS_GetOpaque(obj, class) };
    if p.is_null() {
        return;
    }
    let (id, generation) = unpack(p);
    // Only what the object owns: the value of a live memo is its node's,
    // which its owner keeps after the object goes. Marked as the object's,
    // a cycle through the object would free it under the graph.
    if g.live(id, generation, GENERATION_MASK) && g.held_by_handle(id) {
        unsafe { qjs::JS_MarkValue(rt, *g.value(id), mark) };
        if let Some(f) = g.custom_equals(id) {
            unsafe { qjs::JS_MarkValue(rt, *f, mark) };
        }
    }
}

/// A new object of `class` naming node `id`.
fn object(cx: *mut JsContext, class: qjs::JSClassID, id: u32) -> JsValue {
    // SAFETY: a registered class; the opaque is a packed handle.
    unsafe {
        let generation = graph(cx).generation(id);
        let obj = qjs::JS_NewObjectClass(cx, class);
        qjs::JS_SetOpaque(obj, pack(id, generation));
        obj
    }
}

// --- Natives --------------------------------------------------------------

pub(crate) fn arg(argc: c_int, argv: *mut JsValue, i: usize) -> JsValue {
    if (i as c_int) < argc {
        // SAFETY: QuickJS passes `argc` values.
        unsafe { *argv.add(i) }
    } else {
        UNDEFINED
    }
}

/// `equals` of an options object.
fn equals_option(cx: *mut JsContext, options: JsValue) -> Equals<JsValue> {
    // SAFETY: reading a property of a live value.
    unsafe {
        if !qjs::JS_IsObject(options) {
            return Equals::Default;
        }
        let e = qjs::JS_GetPropertyStr(cx, options, c"equals".as_ptr());
        if qjs::JS_IsFunction(cx, e) {
            Equals::Custom(e)
        } else {
            let never = qjs::JS_IsBool(e) && !qjs::JS_VALUE_GET_BOOL(e);
            qjs::JS_FreeValue(cx, e);
            if never {
                Equals::Never
            } else {
                Equals::Default
            }
        }
    }
}

pub(crate) type Native =
    unsafe extern "C" fn(*mut JsContext, JsValue, c_int, *mut JsValue) -> JsValue;

/// A new signal node holding `value` (borrowed), with `options`' equality.
fn new_signal_node(cx: *mut JsContext, value: JsValue, options: JsValue) -> u32 {
    let value = unsafe { qjs::JS_DupValue(cx, value) };
    let equals = equals_option(cx, options);
    unsafe { graph(cx) }.signal(value, equals)
}

/// `createSignal(value, options)`: `[read, write]`.
#[cfg(test)]
unsafe extern "C" fn create_signal(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let id = new_signal_node(cx, arg(argc, argv, 0), arg(argc, argv, 1));
    let classes = unsafe { graph(cx) }.data.classes;
    let mut pair = [
        object(cx, classes.signal, id),
        object(cx, classes.setter, id),
    ];
    unsafe { qjs::JS_NewArrayFrom(cx, 2, pair.as_mut_ptr()) }
}

/// `createMemo(fn, value, options)`.
unsafe extern "C" fn create_memo(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (func, value) = unsafe {
        (
            qjs::JS_DupValue(cx, arg(argc, argv, 0)),
            qjs::JS_DupValue(cx, arg(argc, argv, 1)),
        )
    };
    let equals = equals_option(cx, arg(argc, argv, 2));
    let id = r::memo(Js(cx), func, value, equals, true);
    let class = unsafe { graph(cx) }.data.classes.memo;
    let obj = object(cx, class, id);
    finish(cx, obj)
}

fn create_effect(cx: *mut JsContext, argc: c_int, argv: *mut JsValue, kind: Kind) -> JsValue {
    let (func, value) = unsafe {
        (
            qjs::JS_DupValue(cx, arg(argc, argv, 0)),
            qjs::JS_DupValue(cx, arg(argc, argv, 1)),
        )
    };
    r::effect(Js(cx), kind, func, value);
    finish(cx, UNDEFINED)
}

/// `createRenderEffect(fn, value)`.
#[cfg(test)]
unsafe extern "C" fn create_render_effect(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    create_effect(cx, argc, argv, Kind::Effect)
}

/// `createEffect(fn, value)`.
unsafe extern "C" fn create_user_effect(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    create_effect(cx, argc, argv, Kind::UserEffect)
}

/// The owner a handle names (`getOwner()`'s value), `UNOWNED` for others.
#[cfg(test)]
fn owner_of(cx: *mut JsContext, handle: JsValue) -> Option<u32> {
    // SAFETY: inline tag checks.
    unsafe {
        if qjs::JS_IsUndefined(handle) {
            return None;
        }
        let mut v = 0f64;
        if !qjs::JS_IsNumber(handle) || qjs::JS_ToFloat64(cx, &mut v, handle) != 0 {
            return Some(UNOWNED);
        }
        let bits = v as u64;
        let (id, generation) = (bits as u32, (bits >> 32) as u32);
        let g = graph(cx);
        Some(if g.live(id, generation, u32::MAX) && !g.disposed(id) {
            id
        } else {
            UNOWNED
        })
    }
}

#[cfg(test)]
unsafe extern "C" fn dispose_root(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let handle = unsafe { *data };
    if let Some(id) = owner_of(cx, handle).filter(|&id| id != UNOWNED) {
        // Untracked: disposing reads nothing.
        r::dispose_owner(Js(cx), id);
    }
    finish(cx, UNDEFINED)
}

/// `createRoot(fn, owner)`: `fn(dispose)` (a root without the parameter
/// is never disposed and owns nothing).
#[cfg(test)]
unsafe extern "C" fn create_root(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let func = arg(argc, argv, 0);
    let detached = owner_of(cx, arg(argc, argv, 1));
    let mut length = 0i32;
    unsafe {
        let l = qjs::JS_GetPropertyStr(cx, func, c"length".as_ptr());
        qjs::JS_ToInt32(cx, &mut length, l);
        qjs::JS_FreeValue(cx, l);
    }
    let (root, args) = if length == 0 {
        (UNOWNED, Vec::new())
    } else {
        let g = unsafe { graph(cx) };
        let previous = detached.map(|owner| g.set_owner(owner));
        let id = g.root();
        if let Some(previous) = previous {
            g.set_owner(previous);
        }
        let mut data = [handle_value(cx, id)];
        let dispose =
            unsafe { qjs::JS_NewCFunctionData(cx, Some(dispose_root), 0, 0, 1, data.as_mut_ptr()) };
        (id, vec![dispose])
    };
    let mut args = args;
    let func = unsafe { qjs::JS_DupValue(cx, func) };
    let result = r::with_owner(Js(cx), root, || call(cx, func, &mut args));
    unsafe {
        qjs::JS_FreeValue(cx, func);
        for a in args {
            qjs::JS_FreeValue(cx, a);
        }
    }
    finish(cx, result.unwrap_or(UNDEFINED))
}

/// An owner handle: a number packing the node and its generation.
#[cfg(test)]
fn handle_value(cx: *mut JsContext, id: u32) -> JsValue {
    let generation = unsafe { graph(cx) }.generation(id);
    qjs::JS_NewFloat64((((generation as u64) << 32) | id as u64) as f64)
}

/// `untrack(fn)`.
pub(crate) unsafe extern "C" fn untrack(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    r::untracked(Js(cx), || unsafe {
        qjs::JS_Call(cx, arg(argc, argv, 0), UNDEFINED, 0, ptr::null_mut())
    })
}

/// `batch(fn)`.
pub(crate) unsafe extern "C" fn batch(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let func = unsafe { qjs::JS_DupValue(cx, arg(argc, argv, 0)) };
    let r = r::batch(Js(cx), || call(cx, func, &mut []));
    unsafe { qjs::JS_FreeValue(cx, func) };
    finish(cx, r.unwrap_or(UNDEFINED))
}

/// `onCleanup(fn)`: runs before the owner runs again or is disposed.
pub(crate) unsafe extern "C" fn on_cleanup(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let f = arg(argc, argv, 0);
    let owned = unsafe { qjs::JS_DupValue(cx, f) };
    if let Err(owned) = unsafe { graph(cx) }.on_cleanup(owned) {
        unsafe { qjs::JS_FreeValue(cx, owned) };
    }
    unsafe { qjs::JS_DupValue(cx, f) }
}

/// `getOwner()`: a handle, or `undefined`.
#[cfg(test)]
unsafe extern "C" fn get_owner(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let g = unsafe { graph(cx) };
    if g.has_owner() {
        handle_value(cx, g.owner())
    } else {
        UNDEFINED
    }
}

/// `runWithOwner(owner, fn)`.
#[cfg(test)]
unsafe extern "C" fn run_with_owner(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let owner = owner_of(cx, arg(argc, argv, 0)).unwrap_or(UNOWNED);
    let func = unsafe { qjs::JS_DupValue(cx, arg(argc, argv, 1)) };
    let r = r::with_owner(Js(cx), owner, || call(cx, func, &mut []));
    unsafe { qjs::JS_FreeValue(cx, func) };
    finish(cx, r.unwrap_or(UNDEFINED))
}

/// `setContext(key, value)`: the current owner and what is made under it
/// from now on see `value` for `key`.
unsafe extern "C" fn set_context(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let frame = unsafe {
        JsFrame {
            key: qjs::JS_DupValue(cx, arg(argc, argv, 0)),
            value: qjs::JS_DupValue(cx, arg(argc, argv, 1)),
            cx,
        }
    };
    // The frame replaced (or the new one, without an owner) is dropped
    // once the graph is no longer borrowed.
    let replaced = unsafe { graph(cx) }.provide(frame);
    drop(replaced);
    UNDEFINED
}

/// The value of `key` in the current owner's context (owned), if set.
pub(crate) fn lookup(cx: *mut JsContext, key: JsValue) -> Option<JsValue> {
    find(cx, unsafe { graph(cx) }.context(), key)
}

/// The value of `key` in `frame` or a frame it shadows (owned), if set.
fn find(
    cx: *mut JsContext,
    mut frame: Option<std::rc::Rc<r::Frame<Js>>>,
    key: JsValue,
) -> Option<JsValue> {
    while let Some(f) = frame {
        if unsafe { qjs::JS_IsStrictEqual(cx, f.data.key, key) } {
            return Some(unsafe { qjs::JS_DupValue(cx, f.data.value) });
        }
        frame = f.parent.clone();
    }
    None
}

/// `useContext(key)`: the nearest value set for `key`, or `undefined`.
#[cfg(test)]
unsafe extern "C" fn use_context(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    lookup(cx, arg(argc, argv, 0)).unwrap_or(UNDEFINED)
}

/// A graph for context `raw`, with its classes registered.
pub(crate) fn new_graph(raw: *mut JsContext) -> Graph {
    // SAFETY: registering classes on the context's runtime.
    unsafe {
        let rt = qjs::JS_GetRuntime(raw);
        let function_proto = qjs::JS_GetFunctionProto(raw);
        let class = |name: &'static CStr, call: qjs::JSClassCall, mark: bool, proto: JsValue| {
            let mut id: qjs::JSClassID = 0;
            qjs::JS_NewClassID(rt, &mut id);
            let def = qjs::JSClassDef {
                class_name: name.as_ptr(),
                finalizer: Some(finalize),
                gc_mark: if mark { Some(gc_mark) } else { None },
                call,
                exotic: ptr::null_mut(),
            };
            qjs::JS_NewClass(rt, id, &def);
            // Calls of their objects are function calls (`typeof` is
            // "function"); `proto` is taken.
            qjs::JS_SetClassProto(raw, id, proto);
            id
        };
        // A signal's methods: `count.set(1)`, `count.update(n => n + 1)`.
        // Getters, so that each signal has its own, bound to it: passed on
        // their own (`onChange={count.set}`) they still write `count`.
        let signal_proto = qjs::JS_NewObjectProto(raw, function_proto);
        for (name, getter) in [
            (c"set", signal_set_getter as Native),
            (c"update", signal_update_getter as Native),
        ] {
            let get = new_function(raw, name, getter, 0);
            let atom = qjs::JS_NewAtom(raw, name.as_ptr());
            qjs::JS_DefinePropertyGetSet(
                raw,
                signal_proto,
                atom,
                get,
                UNDEFINED,
                qjs::JS_PROP_CONFIGURABLE as c_int,
            );
            qjs::JS_FreeAtom(raw, atom);
        }
        let classes = Classes {
            signal: class(c"Signal", Some(signal_call), true, signal_proto),
            setter: class(
                c"SignalSetter",
                Some(setter_call),
                false,
                qjs::JS_DupValue(raw, function_proto),
            ),
            memo: class(
                c"Memo",
                Some(signal_call),
                true,
                qjs::JS_DupValue(raw, function_proto),
            ),
            resource: crate::resource::register(raw),
        };
        qjs::JS_FreeValue(raw, function_proto);
        Graph::new(JsData {
            cx: raw,
            classes,
            error: None,
            boundary_key: qjs::JS_NewObject(raw),
            caught: Vec::new(),
            running: 0,
        })
    }
}

/// Frees every JS value the graph holds (the state is unregistered:
/// finalizers that run meanwhile leave the graph alone).
pub(crate) fn free_all(graph: &mut Graph, raw: *mut JsContext) {
    graph.free_all(Js(raw));
    if let Some(e) = graph.data.error.take() {
        // SAFETY: the graph's own value; no JS runs from here on.
        unsafe { qjs::JS_FreeValue(raw, e) };
    }
    for (boundary, error) in std::mem::take(&mut graph.data.caught) {
        // SAFETY: the graph's own values.
        unsafe {
            qjs::JS_FreeValue(raw, boundary);
            qjs::JS_FreeValue(raw, error);
        }
    }
    let key = std::mem::replace(&mut graph.data.boundary_key, UNDEFINED);
    // SAFETY: the graph's own value.
    unsafe { qjs::JS_FreeValue(raw, key) };
}

/// A native function named `name`.
pub(crate) fn new_function(cx: *mut JsContext, name: &CStr, f: Native, length: c_int) -> JsValue {
    // SAFETY: a plain C function.
    unsafe {
        qjs::JS_NewCFunction2(
            cx,
            Some(f),
            name.as_ptr(),
            length,
            qjs::JSCFunctionEnum_JS_CFUNC_generic,
            0,
        )
    }
}

/// The graph's primitives as `globalThis.__nsh_reactive`, for tests that
/// drive owners and roots directly.
#[cfg(test)]
pub(crate) fn install_globals(cx: &Ctx<'_>) {
    let raw = cx.as_raw().as_ptr();
    // SAFETY: natives on the global object.
    unsafe {
        let obj = qjs::JS_NewObject(raw);
        let natives: [(&CStr, Native, c_int); 13] = [
            (c"createSignal", create_signal, 2),
            (c"createMemo", create_memo, 3),
            (c"createRenderEffect", create_render_effect, 2),
            (c"createEffect", create_user_effect, 2),
            (c"createRoot", create_root, 2),
            (c"untrack", untrack, 1),
            (c"batch", batch, 1),
            (c"onCleanup", on_cleanup, 1),
            (c"getOwner", get_owner, 0),
            (c"runWithOwner", run_with_owner, 2),
            (c"setContext", set_context, 2),
            (c"useContext", use_context, 1),
            (c"isAccessor", is_accessor, 1),
        ];
        for (name, f, length) in natives {
            let func = new_function(raw, name, f, length);
            qjs::JS_SetPropertyStr(raw, obj, name.as_ptr(), func);
        }
        let global = qjs::JS_GetGlobalObject(raw);
        qjs::JS_SetPropertyStr(raw, global, c"__nsh_reactive".as_ptr(), obj);
        qjs::JS_FreeValue(raw, global);
    }
}

/// `isAccessor(value)`: whether `value` is a signal or memo object.
#[cfg(test)]
unsafe extern "C" fn is_accessor(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let v = arg(argc, argv, 0);
    let classes = unsafe { graph(cx) }.data.classes;
    let class = unsafe { qjs::JS_GetClassID(v) };
    let yes = class == classes.signal || class == classes.memo;
    if yes { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

// --- `nsh`'s API ------------------------------------------------------------

/// `signal(value, options)`: a signal object, read by calling it.
pub(crate) unsafe extern "C" fn signal(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let id = new_signal_node(cx, arg(argc, argv, 0), arg(argc, argv, 1));
    let class = unsafe { graph(cx) }.data.classes.signal;
    object(cx, class, id)
}

/// Whether `v` (borrowed) is a signal object (`signal()`), and whether
/// it is a memo's (`memo()`, read-only).
pub(crate) fn signal_kind(cx: *mut JsContext, v: JsValue) -> (bool, bool) {
    let classes = unsafe { graph(cx) }.data.classes;
    // SAFETY: reads the class of a live value.
    let class = unsafe { qjs::JS_GetClassID(v) };
    (class == classes.signal, class == classes.memo)
}

/// `signal.set` and `signal.update`: methods of a signal of their own,
/// bound to it (cached on the signal on first use). They hold the node's
/// handle, not the signal, so they keep nothing alive and write nothing
/// once the signal is gone. Read off anything but a signal (the
/// prototype), they are the unbound methods, which throw.
fn bound_method(cx: *mut JsContext, this: JsValue, name: &CStr, update: bool) -> JsValue {
    let class = unsafe { graph(cx) }.data.classes.signal;
    let Some(id) = (unsafe { node_of(cx, this, class) }) else {
        let f: Native = if update { signal_update } else { signal_set };
        return new_function(cx, name, f, 1);
    };
    let generation = unsafe { graph(cx) }.generation(id);
    // SAFETY: plain values as the function's data; `this` is a live signal.
    unsafe {
        let mut data = [
            qjs::JS_NewFloat64(id.into()),
            qjs::JS_NewFloat64(generation.into()),
        ];
        let func = qjs::JS_NewCFunctionData(
            cx,
            Some(bound_call),
            1,
            update as c_int,
            2,
            data.as_mut_ptr(),
        );
        qjs::JS_DefinePropertyValueStr(
            cx,
            func,
            c"name".as_ptr(),
            qjs::JS_NewStringLen(cx, name.as_ptr(), name.count_bytes() as _),
            qjs::JS_PROP_CONFIGURABLE as c_int,
        );
        qjs::JS_DefinePropertyValueStr(
            cx,
            this,
            name.as_ptr(),
            qjs::JS_DupValue(cx, func),
            qjs::JS_PROP_CONFIGURABLE as c_int,
        );
        func
    }
}

unsafe extern "C" fn signal_set_getter(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    bound_method(cx, this, c"set", false)
}

unsafe extern "C" fn signal_update_getter(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    bound_method(cx, this, c"update", true)
}

/// A bound `set` (`magic` 0) or `update` (1); `data` is the node's id and
/// generation.
unsafe extern "C" fn bound_call(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let (mut id, mut generation) = (0.0, 0.0);
    // SAFETY: the two numbers `bound_method` gave.
    unsafe {
        qjs::JS_ToFloat64(cx, &mut id, *data);
        qjs::JS_ToFloat64(cx, &mut generation, *data.add(1));
    }
    let (id, generation) = (id as u32, generation as u32);
    if !unsafe { graph(cx) }.live(id, generation, u32::MAX) {
        return UNDEFINED;
    }
    if magic == 0 {
        write_value(cx, id, arg(argc, argv, 0))
    } else {
        update_value(cx, id, arg(argc, argv, 0))
    }
}

/// The signal `this` names, or a thrown `TypeError`.
fn this_signal(cx: *mut JsContext, this: JsValue) -> Result<u32, JsValue> {
    let class = unsafe { graph(cx) }.data.classes.signal;
    match unsafe { node_of(cx, this, class) } {
        Some(id) => Ok(id),
        // SAFETY: throwing on a live context.
        None => Err(unsafe { qjs::JS_ThrowTypeError(cx, c"not a live signal".as_ptr()) }),
    }
}

/// `signal.set(value)`, unbound.
unsafe extern "C" fn signal_set(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    match this_signal(cx, this) {
        Ok(id) => write_value(cx, id, arg(argc, argv, 0)),
        Err(e) => e,
    }
}

/// `signal.update(fn)`, unbound.
unsafe extern "C" fn signal_update(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    match this_signal(cx, this) {
        Ok(id) => update_value(cx, id, arg(argc, argv, 0)),
        Err(e) => e,
    }
}

/// Sets signal `id` to `value` (borrowed).
fn write_value(cx: *mut JsContext, id: u32, value: JsValue) -> JsValue {
    let value = unsafe { qjs::JS_DupValue(cx, value) };
    r::write(Js(cx), id, value);
    finish(cx, UNDEFINED)
}

/// Sets signal `id` to `f(current value)`.
fn update_value(cx: *mut JsContext, id: u32, f: JsValue) -> JsValue {
    let prev = unsafe { qjs::JS_DupValue(cx, *graph(cx).value(id)) };
    let mut args = [prev];
    // SAFETY: a live value; the graph is not borrowed across the call.
    let next = unsafe { qjs::JS_Call(cx, f, UNDEFINED, 1, args.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, args[0]) };
    if unsafe { qjs::JS_IsException(next) } {
        return next;
    }
    r::write(Js(cx), id, next);
    finish(cx, UNDEFINED)
}

/// `computed(fn, options)`: a memo object, read by calling it.
pub(crate) unsafe extern "C" fn computed(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut args = [arg(argc, argv, 0), UNDEFINED, arg(argc, argv, 1)];
    // SAFETY: borrowed arguments, as `createMemo` takes them.
    unsafe { create_memo(cx, UNDEFINED, 3, args.as_mut_ptr()) }
}

/// `effect(fn)`: runs `fn` after rendering, and again when what it read
/// changes.
pub(crate) unsafe extern "C" fn effect(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut data = [arg(argc, argv, 0)];
    // SAFETY: the function keeps a dup of `fn`; the effect a dup of it.
    unsafe {
        let run = qjs::JS_NewCFunctionData(cx, Some(effect_run), 0, 0, 1, data.as_mut_ptr());
        let mut args = [run];
        let r = create_user_effect(cx, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, run);
        r
    }
}

/// A run of an `effect(fn)`: a function `fn` returns is its cleanup, as
/// `cleanup(f)` in it would be (React's habit): it runs before the effect
/// runs again or goes away. Anything else returned (an async effect's
/// promise) is dropped.
unsafe extern "C" fn effect_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`effect`); the result is owned.
    unsafe {
        let r = qjs::JS_Call(cx, *data, UNDEFINED, 0, ptr::null_mut());
        if qjs::JS_IsException(r) {
            return r;
        }
        if qjs::JS_IsFunction(cx, r) {
            // The effect is the running owner.
            add_cleanup(cx, r);
        } else {
            qjs::JS_FreeValue(cx, r);
        }
    }
    UNDEFINED
}

// --- For the renderer -------------------------------------------------------

/// Makes a render effect running `func` (owned) under the current owner,
/// runs it, and returns the value of that first run (owned).
pub(crate) fn render_effect(cx: *mut JsContext, func: JsValue) -> JsValue {
    let id = r::effect(Js(cx), Kind::Effect, func, UNDEFINED);
    // SAFETY: a dup of the node's value (a disposed node holds undefined).
    unsafe { qjs::JS_DupValue(cx, *graph(cx).value(id)) }
}

/// A new signal object holding `value` (borrowed).
pub(crate) fn new_signal(cx: *mut JsContext, value: JsValue) -> JsValue {
    let mut args = [value];
    // SAFETY: borrowed arguments, as `signal` takes them.
    unsafe { signal(cx, UNDEFINED, 1, args.as_mut_ptr()) }
}

/// The class of resource objects (`crate::resource`).
pub(crate) fn resource_class(cx: *mut JsContext) -> qjs::JSClassID {
    unsafe { graph(cx) }.data.classes.resource
}

/// Registers `f` (owned) to run before the current owner runs again or is
/// disposed (freed at once with no owner).
pub(crate) fn add_cleanup(cx: *mut JsContext, f: JsValue) {
    if let Err(f) = unsafe { graph(cx) }.on_cleanup(f) {
        unsafe { qjs::JS_FreeValue(cx, f) };
    }
}

/// Writes `value` (owned) to signal object `obj` (does nothing for a dead
/// one).
pub(crate) fn set_signal(cx: *mut JsContext, obj: JsValue, value: JsValue) {
    match this_signal(cx, obj) {
        Ok(id) => r::write(Js(cx), id, value),
        Err(e) => unsafe {
            // Not reachable for the renderer's own signals; drop the error.
            qjs::JS_FreeValue(cx, e);
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            qjs::JS_FreeValue(cx, value);
        },
    }
}

/// The number signal object `obj` holds (untracked), if it holds one.
pub(crate) fn peek_number(cx: *mut JsContext, obj: JsValue) -> Option<f64> {
    let v = peek(cx, obj);
    // SAFETY: an inline check and a conversion of a live value.
    unsafe {
        if !qjs::JS_IsNumber(v) {
            return None;
        }
        let mut n = 0f64;
        qjs::JS_ToFloat64(cx, &mut n, v);
        Some(n)
    }
}

/// The current value of signal object `obj` (borrowed; untracked), if live.
pub(crate) fn peek(cx: *mut JsContext, obj: JsValue) -> JsValue {
    let class = unsafe { graph(cx) }.data.classes.signal;
    match unsafe { node_of(cx, obj, class) } {
        Some(id) => *unsafe { graph(cx) }.value(id),
        None => UNDEFINED,
    }
}

/// Makes a memo of `func` (owned) under the current owner and returns its
/// object.
pub(crate) fn memo(cx: *mut JsContext, func: JsValue, equals_truthy: bool) -> JsValue {
    let equals = if equals_truthy {
        Equals::Truthiness
    } else {
        Equals::Default
    };
    let id = r::memo(Js(cx), func, UNDEFINED, equals, true);
    let class = unsafe { graph(cx) }.data.classes.memo;
    object(cx, class, id)
}

/// Runs `f` as one batch: its writes apply together at the end.
pub(crate) fn batch_with<R>(cx: *mut JsContext, f: impl FnOnce() -> R) -> R {
    r::batch(Js(cx), f)
}

/// Runs `f` with no listener (untracked).
pub(crate) fn untracked_with<R>(cx: *mut JsContext, f: impl FnOnce() -> R) -> R {
    r::untracked(Js(cx), f)
}

/// Runs `f` in a new root owner, under the current one (context passes
/// through it); returns the root and `f`'s result. The root is disposed
/// with [`dispose_owner`].
pub(crate) fn with_root<R>(cx: *mut JsContext, f: impl FnOnce() -> R) -> (u32, R) {
    r::with_root(Js(cx), f)
}

/// Whether something owns what runs now (a component, an effect, a
/// root): its cleanups run when it goes.
pub(crate) fn has_owner(cx: *mut JsContext) -> bool {
    unsafe { graph(cx) }.has_owner()
}

/// The current owner (for [`with_root_under`] later).
pub(crate) fn current_owner(cx: *mut JsContext) -> u32 {
    unsafe { graph(cx) }.owner()
}

/// Runs `f` under `owner` with no listener; what it makes belongs to that owner.
pub(crate) fn with_owner<R>(cx: *mut JsContext, owner: u32, f: impl FnOnce() -> R) -> R {
    r::with_owner(Js(cx), owner, f)
}

/// [`with_root`] as if run under `owner` (from [`current_owner`]): rows a
/// list makes later see the list's context.
pub(crate) fn with_root_under<R>(
    cx: *mut JsContext,
    owner: u32,
    f: impl FnOnce() -> R,
) -> (u32, R) {
    r::with_root_under(Js(cx), owner, f)
}

/// Disposes owner `id` (a root from [`with_root`]), untracked.
pub(crate) fn dispose_owner(cx: *mut JsContext, id: u32) {
    r::dispose_owner(Js(cx), id);
}

/// Sets `key` to `value` (both borrowed) in the current owner's context.
pub(crate) fn provide(cx: *mut JsContext, key: JsValue, value: JsValue) {
    let mut args = [key, value];
    // SAFETY: borrowed arguments.
    unsafe { set_context(cx, UNDEFINED, 2, args.as_mut_ptr()) };
}

/// Throws the error the last round kept, if any (natives that ran JS
/// through the graph end with this).
pub(crate) fn finish_value(cx: *mut JsContext, value: JsValue) -> JsValue {
    finish(cx, value)
}

#[cfg(test)]
mod tests {
    use rquickjs::{Context, Runtime};

    /// Runs `code` with the natives as `R` and returns its value as JSON.
    fn run(code: &str) -> String {
        let rt = Runtime::new().unwrap();
        let cx = Context::full(&rt).unwrap();
        cx.with(|cx| {
            crate::state::install(&cx, std::rc::Rc::default(), &[], Default::default());
            super::install_globals(&cx);
            let out: String = cx
                .eval(format!(
                    "(() => {{ const R = globalThis.__nsh_reactive; const out = (() => {{ {code} }})(); return JSON.stringify(out); }})()"
                ))
                .unwrap_or_else(|e| match e {
                    rquickjs::Error::Exception => format!("threw {:?}", cx.catch()),
                    e => format!("error {e}"),
                });
            crate::state::uninstall(&cx);
            out
        })
    }

    #[test]
    fn memos_are_glitch_free_and_lazy_reads_are_current() {
        // A diamond: the effect sees each change once, consistent.
        assert_eq!(
            run(r#"
                const [a, setA] = R.createSignal(1);
                const b = R.createMemo(() => a() * 2);
                const c = R.createMemo(() => a() + 1);
                const log = [];
                R.createRoot(() => R.createRenderEffect(() => log.push(`${b()}/${c()}`)));
                setA(2);
                // Read inside a batch: memos are current before it ends.
                R.batch(() => { setA(3); log.push(`read ${b()}`); });
                return log;
            "#),
            r#"["2/2","4/3","read 6","6/4"]"#
        );
    }

    #[test]
    fn batch_untrack_and_equality() {
        assert_eq!(
            run(r#"
                const [a, setA] = R.createSignal(0);
                const [b, setB] = R.createSignal(0);
                const [c, setC] = R.createSignal({}, { equals: false });
                const [d, setD] = R.createSignal(1, { equals: (x, y) => x % 2 === y % 2 });
                const log = [];
                R.createRoot(() => {
                    R.createRenderEffect(() => log.push(`ab ${a()} ${R.untrack(b)}`));
                    R.createRenderEffect(() => { c(); log.push("c"); });
                    R.createRenderEffect(() => log.push(`d ${d()}`));
                });
                R.batch(() => { setA(1); setA(2); setB(5); });
                setB(6);          // untracked: nothing
                setC(c());        // equals: false: runs again
                setD(3);          // same parity: nothing
                setD(4);
                return log;
            "#),
            r#"["ab 0 0","c","d 1","ab 2 5","c","d 4"]"#
        );
    }

    #[test]
    fn owners_clean_up_and_dispose_what_they_own() {
        assert_eq!(
            run(r#"
                const [show, setShow] = R.createSignal(true);
                const [n, setN] = R.createSignal(0);
                const log = [];
                const dispose = R.createRoot((dispose) => {
                    R.createRenderEffect(() => {
                        if (!show()) return;
                        R.onCleanup(() => log.push("outer cleanup"));
                        R.createRenderEffect(() => {
                            log.push(`inner ${n()}`);
                            R.onCleanup(() => log.push(`inner cleanup ${n()}`));
                        });
                    });
                    return dispose;
                });
                setN(1);
                setShow(false);   // disposes the inner effect
                setN(2);          // nothing runs
                setShow(true);
                dispose();
                setN(3);          // disposed: nothing
                return log;
            "#),
            // Cleanups read the signal when they run.
            r#"["inner 0","inner cleanup 1","inner 1","inner cleanup 1","outer cleanup","inner 2","inner cleanup 2","outer cleanup"]"#
        );
    }

    #[test]
    fn context_owners_and_user_effects() {
        assert_eq!(
            run(r#"
                const key = Symbol("k");
                const log = [];
                let owner;
                // A root with `dispose` (one without is unowned: no context).
                R.createRoot((dispose) => {
                    R.setContext(key, "root");
                    R.createRenderEffect(() => {
                        log.push(`render ${R.useContext(key)}`);
                        R.setContext(key, "inner");
                        owner = R.getOwner();
                    });
                    R.createEffect(() => log.push("user after render"));
                    R.createRenderEffect(() => log.push("render 2"));
                });
                R.runWithOwner(owner, () => log.push(`with owner ${R.useContext(key)}`));
                log.push(`outside ${R.useContext(key)}`);
                return log;
            "#),
            r#"["render root","render 2","user after render","with owner inner","outside undefined"]"#
        );
    }

    #[test]
    fn throwing_computations_report_the_error_and_recover_with_the_graph() {
        assert_eq!(
            run(r#"
                const [a, setA] = R.createSignal(0);
                const log = [];
                R.createRoot(() => {
                    R.createRenderEffect(() => { if (a() === 1) throw new Error("boom"); log.push(`ok ${a()}`); });
                    R.createRenderEffect(() => log.push(`other ${a()}`));
                });
                try { setA(1); } catch (e) { log.push(`caught ${e.message}`); }
                setA(2);
                return log;
            "#),
            r#"["ok 0","other 0","other 1","caught boom","ok 2","other 2"]"#
        );
        assert_eq!(
            run(r#"
                const [a, setA] = R.createSignal(0);
                const log = [];
                let value;
                R.createRoot(() => {
                    value = R.createMemo(() => {
                        const n = a();
                        if (n === 1) throw new Error("memo boom");
                        return n * 2;
                    });
                    const derived = R.createMemo(() => value() + 1);
                    R.createRenderEffect(() => log.push(`value ${derived()}`));
                });
                try { setA(1); } catch (e) { log.push(`caught ${e.message}`); }
                // A lazy read of the unchanged failing memo still throws;
                // it must not silently return its last successful value.
                try { value(); } catch (e) { log.push(`read ${e.message}`); }
                setA(2);
                return log;
            "#),
            r#"["value 1","caught memo boom","read memo boom","value 5"]"#
        );
    }

    #[test]
    fn unreachable_signals_are_collected() {
        let out = run(r#"
            const [s, set] = R.createSignal(0);
            let last;
            for (let i = 0; i < 20000; i++) {
                const [g, w] = R.createSignal({ i });
                // A cycle through the value: the signal holds a closure over itself.
                w({ get: g });
                last = g;
            }
            return last().get === last;
        "#);
        assert_eq!(out, "true");
        // Collected (also during the loop): slots are reused, none is left.
        let rt = rquickjs::Runtime::new().unwrap();
        let cx = rquickjs::Context::full(&rt).unwrap();
        // The nodes the state itself keeps (the environment's).
        let live = |raw| {
            // SAFETY: the graph `install` made; no JS runs meanwhile.
            let g = unsafe { super::graph(raw) };
            g.slots()
        };
        let before = cx.with(|cx| {
            crate::state::install(&cx, std::rc::Rc::default(), &[], Default::default());
            super::install_globals(&cx);
            let before = live(cx.as_raw().as_ptr()).0;
            let _: () = cx
                .eval("const R = globalThis.__nsh_reactive; for (let i = 0; i < 5000; i++) { const [g, w] = R.createSignal(0); w({ g }); }")
                .unwrap();
            before
        });
        rt.run_gc();
        let (after, slots) = cx.with(|cx| {
            let counts = live(cx.as_raw().as_ptr());
            crate::state::uninstall(&cx);
            counts
        });
        assert!(slots < 5000, "{slots} nodes for 5000 signals");
        assert_eq!(after, before, "every signal collected");
    }

    #[test]
    fn a_live_memo_keeps_its_value_when_its_object_is_collected() {
        // The memo's object goes, but its root does not: the node (and the
        // value it holds) lives on in the graph. A cycle through the value
        // must not let the collector free the value under the graph, which
        // frees it again when the memo runs again or the graph goes.
        let rt = rquickjs::Runtime::new().unwrap();
        let cx = rquickjs::Context::full(&rt).unwrap();
        cx.with(|cx| {
            crate::state::install(&cx, std::rc::Rc::default(), &[], Default::default());
            super::install_globals(&cx);
            let _: () = cx
                .eval(
                    r#"
                    const R = globalThis.__nsh_reactive;
                    R.createRoot(() => {
                        const m = R.createMemo(() => ({ n: 1 }));
                        // A cycle: the value holds the memo's object.
                        m().memo = m;
                        globalThis.weak = new WeakRef(m());
                    });
                    "#,
                )
                .unwrap();
        });
        rt.run_gc();
        let kept: bool = cx.with(|cx| cx.eval("globalThis.weak.deref()?.n === 1").unwrap());
        assert!(kept, "the live memo's value was collected");
        cx.with(|cx| crate::state::uninstall(&cx));
    }

    #[test]
    fn effects_made_untracked_in_a_root_still_track() {
        // The renderer's shape: `render` (a root), `createComponent`
        // (untrack), `insert` (a render effect reading an accessor).
        assert_eq!(
            run(r#"
                const [c, setC] = R.createSignal(0);
                const log = [];
                R.createRoot((dispose) => {
                    R.untrack(() => {
                        R.createRenderEffect((cur) => { const v = c(); log.push(v); return v; });
                    });
                });
                setC(1);
                return log;
            "#),
            "[0,1]"
        );
    }

    #[test]
    fn a_memo_bumped_in_a_batch_updates_its_readers() {
        // Hot reload's component proxies: a memo of a version signal.
        assert_eq!(
            run(r#"
                const [v, setV] = R.createSignal(0);
                let fn = () => "a";
                const log = [];
                R.createRoot((dispose) => {
                    const m = R.createMemo(() => { v(); return R.untrack(() => fn()); });
                    R.createRenderEffect(() => log.push(m()));
                });
                fn = () => "b";
                R.batch(() => setV((x) => x + 1));
                return log;
            "#),
            r#"["a","b"]"#
        );
    }

    #[test]
    fn computations_made_during_an_update_run_at_once() {
        // A provider made while a list renders a new item returns what its
        // render effect produced, so the effect must not wait in the queue.
        assert_eq!(
            run(r#"
                const [items, setItems] = R.createSignal([0]);
                const log = [];
                R.createRoot(() => {
                    R.createRenderEffect(() => {
                        for (const i of items()) {
                            let made;
                            R.createRenderEffect(() => { made = i; });
                            const m = R.createMemo(() => i * 10);
                            log.push([made, m()]);
                        }
                    });
                });
                setItems([0, 1]);
                return log;
            "#),
            r#"[[0,0],[0,0],[1,10]]"#
        );
    }

    #[test]
    fn effects_follow_signals() {
        assert_eq!(
            run(r#"
                const [c, setC] = R.createSignal(0);
                const log = [];
                R.createRoot(() => { R.createRenderEffect(() => log.push(c())); });
                setC(1);
                setC((n) => n + 1);
                setC(2);
                return log;
            "#),
            "[0,1,2]"
        );
    }
}
