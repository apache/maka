//! `resource(source, fetcher)`: a value loaded asynchronously, its JS face
//! (Rust components' is `nsh_core::element::resource`). The bookkeeping of its
//! loads is [`nsh_core::resource::Runs`], shared with the Rust face.
//!
//! A resource is a callable object (`user()` reads the latest value, as a
//! signal is read) of its own class, holding four signals (the value, the
//! error, the state's name, a refetch counter), the source, the fetcher
//! and the running load's `AbortSignal`. One render effect per resource
//! reads the source and starts a load: the fetcher is called untracked
//! with the source and `{ signal, refetching }`, and the promise it returns
//! is followed natively. The effect's cleanup (it runs again, or its owner
//! goes away) aborts the signal and marks the load as no longer counting,
//! so a load superseded or orphaned changes nothing when it ends.

use std::{
    ffi::{c_int, c_void},
    ptr,
};

use nsh_core::resource::{ResourceState, Run, Runs};
use rquickjs::qjs;

use crate::reactive;

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// What a resource object holds (owned values).
struct Data {
    runs: Runs,
    /// The latest value.
    value: JsValue,
    /// The last load's error.
    error: JsValue,
    /// The state's name ([`ResourceState::name`]).
    state: JsValue,
    /// Written by `refetch()`, read by the load's effect.
    trigger: JsValue,
    /// An accessor or a value; `None`: the fetcher takes the info alone.
    source: Option<JsValue>,
    fetcher: JsValue,
    /// The running load's `AbortSignal` (`undefined`: none).
    abort: JsValue,
    refetching: bool,
}

impl Data {
    fn values(&self) -> impl Iterator<Item = JsValue> + '_ {
        [
            self.value,
            self.error,
            self.state,
            self.trigger,
            self.fetcher,
            self.abort,
        ]
        .into_iter()
        .chain(self.source)
    }
}

/// The resource class: calls read the value; its methods are each
/// object's own, bound to it (`const loading = user.loading` works).
pub(crate) fn register(raw: *mut JsContext) -> qjs::JSClassID {
    // SAFETY: registering a class on the context's runtime.
    unsafe {
        let rt = qjs::JS_GetRuntime(raw);
        let mut id: qjs::JSClassID = 0;
        qjs::JS_NewClassID(rt, &mut id);
        let def = qjs::JSClassDef {
            class_name: c"Resource".as_ptr(),
            finalizer: Some(finalize),
            gc_mark: Some(mark),
            call: Some(call),
            exotic: ptr::null_mut(),
        };
        qjs::JS_NewClass(rt, id, &def);
        // Callable: `typeof user` is "function".
        let proto = qjs::JS_GetFunctionProto(raw);
        qjs::JS_SetClassProto(raw, id, proto);
        id
    }
}

/// The data of resource `obj`, if it is one. Read briefly: no JS runs
/// while it is held.
fn data<'a>(cx: *mut JsContext, obj: JsValue) -> Option<&'a mut Data> {
    let class = reactive::resource_class(cx);
    // SAFETY: an object of the class holds its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, class) } as *mut Data;
    (!p.is_null()).then(|| unsafe { &mut *p })
}

unsafe extern "C" fn finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of a resource object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut Data;
    if p.is_null() {
        return;
    }
    let data = unsafe { Box::from_raw(p) };
    for v in data.values() {
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
}

unsafe extern "C" fn mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const Data;
    if p.is_null() {
        return;
    }
    for v in unsafe { &*p }.values() {
        unsafe { qjs::JS_MarkValue(rt, v, mark) };
    }
}

/// Reads signal `signal` (borrowed), tracked.
fn read(cx: *mut JsContext, signal: JsValue) -> JsValue {
    // SAFETY: calling a live signal object.
    unsafe { qjs::JS_Call(cx, signal, UNDEFINED, 0, ptr::null_mut()) }
}

/// A dup of the signal `pick` chooses of resource `obj`.
fn signal_of(cx: *mut JsContext, obj: JsValue, pick: fn(&Data) -> JsValue) -> Option<JsValue> {
    let d = data(cx, obj)?;
    // SAFETY: a dup of an owned value.
    Some(unsafe { qjs::JS_DupValue(cx, pick(d)) })
}

/// Reads the signal `pick` chooses of resource `obj`, tracked.
fn read_of(cx: *mut JsContext, obj: JsValue, pick: fn(&Data) -> JsValue) -> JsValue {
    let Some(signal) = signal_of(cx, obj, pick) else {
        return not_a_resource(cx);
    };
    let v = read(cx, signal);
    unsafe { qjs::JS_FreeValue(cx, signal) };
    v
}

fn not_a_resource(cx: *mut JsContext) -> JsValue {
    // SAFETY: throwing on a live context.
    unsafe { qjs::JS_ThrowTypeError(cx, c"not a resource".as_ptr()) }
}

/// `user()`: the latest value.
unsafe extern "C" fn call(
    cx: *mut JsContext,
    func: JsValue,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _flags: c_int,
) -> JsValue {
    read_of(cx, func, |d| d.value)
}

/// `user.error()`.
unsafe extern "C" fn error(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`).
    let this = unsafe { *bound };
    read_of(cx, this, |d| d.error)
}

/// `user.state()`.
unsafe extern "C" fn state(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`).
    let this = unsafe { *bound };
    read_of(cx, this, |d| d.state)
}

/// `user.loading()`: whether a load runs (the state, read).
unsafe extern "C" fn loading(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`).
    let this = unsafe { *bound };
    let name = read_of(cx, this, |d| d.state);
    // SAFETY: a live value, freed after the comparison.
    unsafe {
        if qjs::JS_IsException(name) {
            return name;
        }
        let loading = [ResourceState::Pending, ResourceState::Refreshing]
            .iter()
            .any(|s| is_string(cx, name, s.name()));
        qjs::JS_FreeValue(cx, name);
        if loading { qjs::JS_TRUE } else { qjs::JS_FALSE }
    }
}

/// Whether `v` (borrowed) is the string `s`.
fn is_string(cx: *mut JsContext, v: JsValue, s: &str) -> bool {
    // SAFETY: an inline check, then a C string of a live value, freed.
    unsafe {
        if !qjs::JS_IsString(v) {
            return false;
        }
        let mut len = 0;
        let p = qjs::JS_ToCStringLen(cx, &mut len, v);
        if p.is_null() {
            return false;
        }
        let same = std::slice::from_raw_parts(p.cast::<u8>(), len) == s.as_bytes();
        qjs::JS_FreeCString(cx, p);
        same
    }
}

/// A new string of `state`'s name.
fn state_name(cx: *mut JsContext, state: ResourceState) -> JsValue {
    let name = state.name();
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, name.as_ptr().cast(), name.len() as _) }
}

/// `resource(fetcher, options?)` / `resource(source, fetcher, options?)`.
pub(crate) unsafe extern "C" fn resource(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (a0, a1, a2) = (
        reactive::arg(argc, argv, 0),
        reactive::arg(argc, argv, 1),
        reactive::arg(argc, argv, 2),
    );
    // SAFETY: inline checks of live arguments; what is kept is dup'd.
    unsafe {
        let (source, fetcher, options) = if qjs::JS_IsFunction(cx, a1) {
            (Some(qjs::JS_DupValue(cx, a0)), a1, a2)
        } else {
            (None, a0, a1)
        };
        if !qjs::JS_IsFunction(cx, fetcher) {
            if let Some(s) = source {
                qjs::JS_FreeValue(cx, s);
            }
            return qjs::JS_ThrowTypeError(cx, c"resource: the fetcher is not a function".as_ptr());
        }
        let initial = qjs::JS_IsObject(options).then(|| {
            let atom = qjs::JS_NewAtom(cx, c"initialValue".as_ptr());
            let has = qjs::JS_HasProperty(cx, options, atom) > 0;
            let value = has.then(|| qjs::JS_GetProperty(cx, options, atom));
            qjs::JS_FreeAtom(cx, atom);
            value
        });
        let initial = initial.flatten();
        let runs = if initial.is_some() {
            Runs::with_value()
        } else {
            Runs::default()
        };
        let name = state_name(cx, runs.state());
        let zero = qjs::JS_NewFloat64(0.0);
        let data = Box::new(Data {
            value: reactive::new_signal(cx, initial.unwrap_or(UNDEFINED)),
            error: reactive::new_signal(cx, UNDEFINED),
            state: reactive::new_signal(cx, name),
            trigger: reactive::new_signal(cx, zero),
            runs,
            source,
            fetcher: qjs::JS_DupValue(cx, fetcher),
            abort: UNDEFINED,
            refetching: false,
        });
        qjs::JS_FreeValue(cx, name);
        if let Some(v) = initial {
            qjs::JS_FreeValue(cx, v);
        }
        let obj = qjs::JS_NewObjectClass(cx, reactive::resource_class(cx) as _);
        qjs::JS_SetOpaque(obj, Box::into_raw(data) as *mut c_void);
        // Own and bound: `onRefresh={user.refetch}` keeps its resource.
        for (name, f, length) in [
            (c"loading", loading as Bound, 0),
            (c"error", error as Bound, 0),
            (c"state", state as Bound, 0),
            (c"refetch", refetch as Bound, 0),
            (c"mutate", mutate as Bound, 1),
        ] {
            let func = bound(cx, f, length, &mut [obj]);
            qjs::JS_SetPropertyStr(cx, obj, name.as_ptr(), func);
        }
        let run = bound(cx, load, 0, &mut [obj]);
        let r = reactive::render_effect(cx, run);
        qjs::JS_FreeValue(cx, r);
        // A throw of the source is the round's error.
        let r = reactive::finish_value(cx, UNDEFINED);
        if qjs::JS_IsException(r) {
            qjs::JS_FreeValue(cx, obj);
            return r;
        }
        obj
    }
}

type Bound = unsafe extern "C" fn(
    *mut JsContext,
    JsValue,
    c_int,
    *mut JsValue,
    c_int,
    *mut JsValue,
) -> JsValue;

/// A function calling `f` with `data` (borrowed, kept).
fn bound(cx: *mut JsContext, f: Bound, length: c_int, data: &mut [JsValue]) -> JsValue {
    // SAFETY: the function keeps dups of `data`.
    unsafe {
        qjs::JS_NewCFunctionData(
            cx,
            Some(f),
            length,
            0,
            data.len() as c_int,
            data.as_mut_ptr(),
        )
    }
}

/// A run of a resource's effect: reads the source and starts a load.
unsafe extern "C" fn load(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`).
    let obj = unsafe { *bound };
    let Some(trigger) = signal_of(cx, obj, |d| d.trigger) else {
        return UNDEFINED;
    };
    // Tracked: `refetch()` writes it.
    let r = read(cx, trigger);
    unsafe {
        qjs::JS_FreeValue(cx, trigger);
        qjs::JS_FreeValue(cx, r);
    }
    let source = data(cx, obj).and_then(|d| d.source);
    let source = match source {
        // SAFETY: calls and dups of live values.
        Some(s) if unsafe { qjs::JS_IsFunction(cx, s) } => {
            let s = unsafe { qjs::JS_DupValue(cx, s) };
            let v = unsafe { qjs::JS_Call(cx, s, UNDEFINED, 0, ptr::null_mut()) };
            unsafe { qjs::JS_FreeValue(cx, s) };
            if unsafe { qjs::JS_IsException(v) } {
                return v;
            }
            Some(v)
        }
        Some(s) => Some(unsafe { qjs::JS_DupValue(cx, s) }),
        None => None,
    };
    // The load no longer counts once this runs again or goes.
    let stop = bound_value(cx, stop, obj);
    reactive::add_cleanup(cx, stop);
    reactive::untracked_with(cx, || start(cx, obj, source))
}

fn bound_value(cx: *mut JsContext, f: Bound, obj: JsValue) -> JsValue {
    bound(cx, f, 0, &mut [obj])
}

/// Starts a load of `obj` for `source` (owned; `None`: a resource with
/// no source), or none when the source is not set.
fn start(cx: *mut JsContext, obj: JsValue, source: Option<JsValue>) -> JsValue {
    // SAFETY: inline checks of a live value.
    let unset = source.is_some_and(|s| unsafe {
        qjs::JS_IsUndefined(s)
            || qjs::JS_IsNull(s)
            || (qjs::JS_IsBool(s) && qjs::JS_ToBool(cx, s) == 0)
    });
    let Some(d) = data(cx, obj) else {
        free_opt(cx, source);
        return UNDEFINED;
    };
    let refetching = std::mem::take(&mut d.refetching);
    if unset {
        let state = d.runs.skip();
        free_opt(cx, source);
        write(cx, obj, |d| d.state, state_name(cx, state));
        return UNDEFINED;
    }
    let (run, state) = d.runs.start();
    let signal = match crate::web::new_abort_signal(cx) {
        Ok(s) => s,
        Err(_) => {
            free_opt(cx, source);
            return qjs::JS_EXCEPTION;
        }
    };
    // SAFETY: the signal is owned by the data now; a dup goes to the load.
    let fetcher = unsafe {
        let d = data(cx, obj).expect("checked above");
        qjs::JS_FreeValue(cx, std::mem::replace(&mut d.abort, signal));
        qjs::JS_DupValue(cx, d.fetcher)
    };
    write(cx, obj, |d| d.state, state_name(cx, state));
    // SAFETY: a new object holding dups.
    let info = unsafe {
        let info = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, info, c"signal".as_ptr(), qjs::JS_DupValue(cx, signal));
        qjs::JS_SetPropertyStr(
            cx,
            info,
            c"refetching".as_ptr(),
            if refetching {
                qjs::JS_TRUE
            } else {
                qjs::JS_FALSE
            },
        );
        info
    };
    let mut args: Vec<JsValue> = source.into_iter().chain([info]).collect();
    // SAFETY: a call with owned arguments, freed after it.
    let result = unsafe {
        let r = qjs::JS_Call(
            cx,
            fetcher,
            UNDEFINED,
            args.len() as c_int,
            args.as_mut_ptr(),
        );
        qjs::JS_FreeValue(cx, fetcher);
        for a in args {
            qjs::JS_FreeValue(cx, a);
        }
        r
    };
    follow(cx, obj, run, result);
    UNDEFINED
}

/// Follows what the fetcher gave for `run` (owned): a promise or another
/// thenable settles the load when it settles, a throw fails it, any other
/// value ends it.
fn follow(cx: *mut JsContext, obj: JsValue, run: Run, result: JsValue) {
    // SAFETY: inline checks and calls of live values; what is made is
    // freed or handed on.
    unsafe {
        if qjs::JS_IsException(result) {
            let e = qjs::JS_GetException(cx);
            settle(cx, obj, run, Err(e));
            return;
        }
        let then = if qjs::JS_IsObject(result) {
            qjs::JS_GetPropertyStr(cx, result, c"then".as_ptr())
        } else {
            UNDEFINED
        };
        if !qjs::JS_IsFunction(cx, then) {
            qjs::JS_FreeValue(cx, then);
            settle(cx, obj, run, Ok(result));
            return;
        }
        let bits = qjs::JS_NewFloat64(run.to_bits() as f64);
        let mut data = [obj, bits];
        let mut handlers = [
            qjs::JS_NewCFunctionData(cx, Some(settled), 1, 0, 2, data.as_mut_ptr()),
            qjs::JS_NewCFunctionData(cx, Some(settled), 1, 1, 2, data.as_mut_ptr()),
        ];
        let r = qjs::JS_Call(cx, then, result, 2, handlers.as_mut_ptr());
        for v in [then, result, r, handlers[0], handlers[1]] {
            qjs::JS_FreeValue(cx, v);
        }
        if qjs::JS_IsException(r) {
            let e = qjs::JS_GetException(cx);
            settle(cx, obj, run, Err(e));
        }
    }
}

/// The handlers of a load's promise: magic 0 fulfilled, 1 rejected; data:
/// the resource and the run.
unsafe extern "C" fn settled(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`follow`); the argument is dup'd.
    let (obj, bits, value) = unsafe {
        (
            *bound,
            *bound.add(1),
            qjs::JS_DupValue(cx, reactive::arg(argc, argv, 0)),
        )
    };
    let mut n = 0.0;
    // SAFETY: a number made by `follow`.
    unsafe { qjs::JS_ToFloat64(cx, &mut n, bits) };
    let run = Run::from_bits(n as u64);
    settle(
        cx,
        obj,
        run,
        if magic == 0 { Ok(value) } else { Err(value) },
    );
    UNDEFINED
}

/// Ends `run` with `outcome` (owned): its value or its error, when it still
/// counts.
fn settle(cx: *mut JsContext, obj: JsValue, run: Run, outcome: Result<JsValue, JsValue>) {
    let ended = data(cx, obj).and_then(|d| {
        let state = match outcome {
            Ok(_) => d.runs.resolve(run),
            Err(_) => d.runs.reject(run),
        }?;
        // A load that ended is not aborted later.
        Some((state, std::mem::replace(&mut d.abort, UNDEFINED)))
    });
    let Some((state, signal)) = ended else {
        // SAFETY: owned.
        unsafe { qjs::JS_FreeValue(cx, outcome.unwrap_or_else(|e| e)) };
        return;
    };
    // SAFETY: the data's signal, now ours.
    unsafe { qjs::JS_FreeValue(cx, signal) };
    reactive::batch_with(cx, || {
        match outcome {
            Ok(value) => {
                write(cx, obj, |d| d.value, value);
                write(cx, obj, |d| d.error, UNDEFINED);
            }
            Err(error) => write(cx, obj, |d| d.error, error),
        }
        write(cx, obj, |d| d.state, state_name(cx, state));
    });
}

/// Writes `value` (owned) to the signal `pick` chooses of `obj`.
fn write(cx: *mut JsContext, obj: JsValue, pick: fn(&Data) -> JsValue, value: JsValue) {
    match signal_of(cx, obj, pick) {
        Some(signal) => {
            reactive::set_signal(cx, signal, value);
            // SAFETY: the dup `signal_of` made.
            unsafe { qjs::JS_FreeValue(cx, signal) };
        }
        // SAFETY: owned.
        None => unsafe { qjs::JS_FreeValue(cx, value) },
    }
}

fn free_opt(cx: *mut JsContext, v: Option<JsValue>) {
    if let Some(v) = v {
        // SAFETY: owned.
        unsafe { qjs::JS_FreeValue(cx, v) };
    }
}

/// The cleanup of a load: it no longer counts, and its signal aborts.
unsafe extern "C" fn stop(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`load`).
    let obj = unsafe { *bound };
    let Some(d) = data(cx, obj) else {
        return UNDEFINED;
    };
    d.runs.cancel();
    let signal = std::mem::replace(&mut d.abort, UNDEFINED);
    // SAFETY: the signal was the data's; aborting runs its listeners.
    unsafe {
        if !qjs::JS_IsUndefined(signal) {
            if crate::web::abort_signal(cx, signal).is_err() {
                qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            }
            qjs::JS_FreeValue(cx, signal);
        }
    }
    UNDEFINED
}

/// `user.refetch()`: loads again from the same source.
unsafe extern "C" fn refetch(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`).
    let obj = unsafe { *bound };
    let Some(d) = data(cx, obj) else {
        return UNDEFINED;
    };
    d.refetching = true;
    let Some(trigger) = signal_of(cx, obj, |d| d.trigger) else {
        return UNDEFINED;
    };
    let n = reactive::peek_number(cx, trigger).unwrap_or(0.0);
    reactive::set_signal(cx, trigger, qjs::JS_NewFloat64(n + 1.0));
    // SAFETY: the dup `signal_of` made.
    unsafe { qjs::JS_FreeValue(cx, trigger) };
    reactive::finish_value(cx, UNDEFINED)
}

/// `user.mutate(value)`: sets the value here, clearing the error.
unsafe extern "C" fn mutate(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    bound: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`resource`); the argument is dup'd.
    let (obj, value) = unsafe { (*bound, reactive::arg(argc, argv, 0)) };
    let Some(d) = data(cx, obj) else {
        return UNDEFINED;
    };
    let state = d.runs.mutate();
    reactive::batch_with(cx, || {
        write(cx, obj, |d| d.value, unsafe { qjs::JS_DupValue(cx, value) });
        write(cx, obj, |d| d.error, UNDEFINED);
        write(cx, obj, |d| d.state, state_name(cx, state));
    });
    reactive::finish_value(cx, unsafe { qjs::JS_DupValue(cx, value) })
}
