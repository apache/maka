//! The JS face of Rust components and modules, made from their specs
//! (`nsh_core::element`).
//!
//! A component is a host view naming it (`component`), its own props
//! converted into their Rust types when they change (one render effect
//! reads them all; a value of the wrong type is a warning, as a host
//! element's, and keeps the prop's value) and set as `Prop::RustProp`, its events delivered to the `on<Event>`
//! handlers, its children inserted when it takes some, and one holder per
//! named slot the app fills, and one holder per (prop, key) a render
//! function renders for (`JsEvent::Render`: rendered in a root of its own,
//! disposed with the holder or the component). A module's function without a context runs in
//! the JS call (`classes.rs`); one with a context or `async`, and a
//! component's method, converts its arguments in the JS call and sends
//! what it runs to the core as an op, in order with the ops before it
//! (`classes::send`). One with a result (`Result<(), E>` included) and
//! every `async` one return a promise, settled when the core's events
//! bring the result ([`deliver`]); an op or method returning `()` returns
//! `undefined`, and nothing answers it.

use std::{
    cell::{Cell, RefCell},
    ffi::{CString, c_int},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::Arc,
};

use nsh_core::{
    Command, EventKind, Op, Prop,
    element::{
        ComponentSpec, FunctionCall, JsEvent, JsIn, JsResult, ModuleSpec, PropDecode, PropKind,
        RustCall,
    },
};
use rquickjs::qjs;
use rustc_hash::FxHashMap;

use crate::{
    dom::{self, string_arg},
    reactive::{self, arg},
    web::js::V,
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The components' part of a context's state.
#[derive(Default)]
pub(crate) struct Components {
    /// The specs of the components made so far (functions name them by
    /// index).
    specs: RefCell<Vec<Arc<ComponentSpec>>>,
    /// Calls waiting for a result: call number -> (resolve, reject), owned.
    pending: RefCell<FxHashMap<u32, (JsValue, JsValue)>>,
    calls: Cell<u32>,
    /// The events each component host has an `on<Event>` handler for, so
    /// an event nobody handles is not converted to JS (a component may
    /// report on every scroll frame).
    handled: RefCell<FxHashMap<nsh_core::NodeId, Box<[&'static str]>>>,
    /// What the functions components hold themselves rendered
    /// (`JsEvent::Render` with a function), by (host, prop U+001F key).
    fn_renders: RefCell<FxHashMap<(nsh_core::NodeId, String), FnRender>>,
    /// `(read) => props` reading the latest value of signal `read`, made
    /// the first time a component's function renders (owned).
    props_of: Cell<Option<JsValue>>,
    /// `(read) => () => f(v)` for the `[f, v]` signal `read` holds, the
    /// content of a prop's render ([`Renders::render`]), made the first
    /// time (owned).
    call_of: Cell<Option<JsValue>>,
    /// The props each component's effect reads ([`props_run`]), by spec
    /// index, made the first time it runs: its own value and renderer
    /// props and the host props it does not declare, with their names'
    /// atoms (owned), so a run allocates nothing for its keys.
    prop_keys: RefCell<Vec<Option<Rc<[PropKey]>>>>,
    /// The atoms of events' handler props (`press` -> `onPress`), by event
    /// name, made the first time (owned).
    handlers: RefCell<FxHashMap<Box<str>, qjs::JSAtom>>,
}

/// A prop a component's effect reads.
struct PropKey {
    name: &'static str,
    /// `name`'s atom (owned by [`Components`]).
    atom: qjs::JSAtom,
    /// Its decoder; `None` for a host prop.
    decode: Option<PropDecode>,
}

/// What a component's own function rendered for a key: JS's holder, the
/// root it was rendered in and the signal of the value its props read
/// (both values owned).
struct FnRender {
    holder: JsValue,
    root: u32,
    value: JsValue,
}

impl Components {
    /// Frees the values the components hold (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        for (_, (resolve, reject)) in self.pending.borrow_mut().drain() {
            // SAFETY: values the table owned; no JS runs from here on.
            unsafe {
                qjs::JS_FreeValue(raw, resolve);
                qjs::JS_FreeValue(raw, reject);
            }
        }
        for (_, r) in self.fn_renders.borrow_mut().drain() {
            // SAFETY: as above.
            unsafe {
                qjs::JS_FreeValue(raw, r.holder);
                qjs::JS_FreeValue(raw, r.value);
            }
        }
        if let Some(f) = self.props_of.take() {
            // SAFETY: as above.
            unsafe { qjs::JS_FreeValue(raw, f) };
        }
        if let Some(f) = self.call_of.take() {
            // SAFETY: as above.
            unsafe { qjs::JS_FreeValue(raw, f) };
        }
        for keys in self.prop_keys.borrow_mut().drain(..).flatten() {
            for key in keys.iter() {
                // SAFETY: atoms the table owned.
                unsafe { qjs::JS_FreeAtom(raw, key.atom) };
            }
        }
        for (_, atom) in self.handlers.borrow_mut().drain() {
            // SAFETY: as above.
            unsafe { qjs::JS_FreeAtom(raw, atom) };
        }
    }
}

fn components<'a>(cx: *mut JsContext) -> &'a Components {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).components }
}

fn new_string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

fn get(cx: *mut JsContext, obj: JsValue, key: &str) -> JsValue {
    // SAFETY: a property read of a live value (undefined for non-objects);
    // the atom is freed.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        let atom = qjs::JS_NewAtomLen(cx, key.as_ptr().cast(), key.len() as _);
        if atom == qjs::JS_ATOM_NULL {
            return qjs::JS_EXCEPTION;
        }
        let v = qjs::JS_GetProperty(cx, obj, atom);
        qjs::JS_FreeAtom(cx, atom);
        v
    }
}

/// `obj[atom]` (undefined for non-objects).
fn get_atom(cx: *mut JsContext, obj: JsValue, atom: qjs::JSAtom) -> JsValue {
    // SAFETY: a property read of a live value.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        qjs::JS_GetProperty(cx, obj, atom)
    }
}

fn has(cx: *mut JsContext, obj: JsValue, key: &str) -> bool {
    // SAFETY: as `get`.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return false;
        }
        let atom = qjs::JS_NewAtomLen(cx, key.as_ptr().cast(), key.len() as _);
        let r = qjs::JS_HasProperty(cx, obj, atom);
        qjs::JS_FreeAtom(cx, atom);
        r == 1
    }
}

/// Whether `obj` has property `atom` (false for non-objects and for an
/// atom that could not be made).
fn has_atom(cx: *mut JsContext, obj: JsValue, atom: qjs::JSAtom) -> bool {
    // SAFETY: a property check of a live value.
    unsafe {
        atom != qjs::JS_ATOM_NULL
            && qjs::JS_IsObject(obj)
            && qjs::JS_HasProperty(cx, obj, atom) == 1
    }
}

/// The atom of event `event`'s handler prop (`press` -> `onPress`), made
/// the first time (owned by [`Components`]); `JS_ATOM_NULL` when it could
/// not be made.
fn handler_atom(cx: *mut JsContext, event: &str) -> qjs::JSAtom {
    let c = components(cx);
    if let Some(&atom) = c.handlers.borrow().get(event) {
        return atom;
    }
    let name = handler_name(event);
    // SAFETY: a new atom, owned by the table.
    let atom = unsafe { qjs::JS_NewAtomLen(cx, name.as_ptr().cast(), name.len() as _) };
    if atom != qjs::JS_ATOM_NULL {
        c.handlers.borrow_mut().insert(event.into(), atom);
    }
    atom
}

/// `press` -> `onPress`.
fn handler_name(event: &str) -> String {
    let mut c = event.chars();
    match c.next() {
        Some(first) => format!("on{}{}", first.to_ascii_uppercase(), c.as_str()),
        None => "on".to_owned(),
    }
}

// --- Calls and their results -----------------------------------------------------------

/// A new call number (never 0: no reply).
pub(crate) fn next_call(cx: *mut JsContext) -> u32 {
    let c = components(cx);
    let n = c.calls.get().wrapping_add(1).max(1);
    c.calls.set(n);
    n
}

/// The promise of call `call`'s result, settled when the core's events
/// bring it ([`deliver`]).
pub(crate) fn promise(cx: *mut JsContext, call: u32) -> JsValue {
    let mut funcs = [UNDEFINED; 2];
    // SAFETY: a new promise; the table owns its functions.
    let promise = unsafe { qjs::JS_NewPromiseCapability(cx, funcs.as_mut_ptr()) };
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(promise) } {
        return promise;
    }
    components(cx)
        .pending
        .borrow_mut()
        .insert(call, (funcs[0], funcs[1]));
    promise
}

/// `ref.evaluate(script, { timeout })` of a web view: a promise the core
/// settles with `{ value }` or the failure. A wrong argument rejects it too
/// (a `TypeError` / `RangeError`), as every call that returns a promise.
pub(crate) fn evaluate(
    cx: *mut JsContext,
    id: Option<u32>,
    script: JsValue,
    options: JsValue,
) -> JsValue {
    use nsh_core::element::{IntoThrown, JsError};
    let call = next_call(cx);
    let promise = promise(cx, call);
    // SAFETY: an inline tag check of the newly allocated promise.
    if unsafe { qjs::JS_IsException(promise) } {
        return promise;
    }
    let reject = |error: JsError| {
        let _ = settle(cx, call, Err(error.into_thrown()));
        promise
    };
    // SAFETY: checks the borrowed argument's tag; no user conversion runs.
    let script = match unsafe { qjs::JS_IsString(script) }
        .then(|| string_arg(cx, script))
        .flatten()
    {
        Some(script) => script,
        None => return reject(JsError::Type("evaluate expects a script string".into())),
    };
    let timeout = match evaluate_timeout(cx, options) {
        Ok(timeout) => timeout,
        Err(error) => return reject(error),
    };
    let Some(id) = id else {
        return reject(JsError::Type("nsh: not a node".into()));
    };
    if dom::push_op(
        cx,
        Op::Evaluate {
            id,
            call,
            script,
            timeout,
        },
    )
    .is_err()
    {
        // The op limit stops the engine; the promise still rejects.
        // SAFETY: take the exception push_op raised on this live VM.
        unsafe { qjs::JS_FreeValue(cx, qjs::JS_GetException(cx)) };
        return reject(JsError::Error(
            "the engine stopped before evaluating".into(),
        ));
    }
    promise
}

/// `evaluate`'s `options.timeout` (milliseconds, 30 seconds when absent).
fn evaluate_timeout(
    cx: *mut JsContext,
    options: JsValue,
) -> Result<std::time::Duration, nsh_core::element::JsError> {
    use nsh_core::element::{EvaluateOptions, JsError};
    // SAFETY: tag checks of a borrowed argument.
    if unsafe { qjs::JS_IsUndefined(options) } {
        return Ok(EvaluateOptions::default().timeout);
    }
    // SAFETY: as above.
    if !unsafe { qjs::JS_IsObject(options) } {
        return Err(JsError::Type("evaluate's options must be an object".into()));
    }
    // SAFETY: reads a property of a live object; the value is freed below.
    let timeout = unsafe { qjs::JS_GetPropertyStr(cx, options, c"timeout".as_ptr()) };
    // SAFETY: tag checks and a number conversion of the owned value.
    let result = unsafe {
        if qjs::JS_IsException(timeout) {
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            Err(JsError::Type("evaluate's timeout could not be read".into()))
        } else if qjs::JS_IsUndefined(timeout) {
            Ok(EvaluateOptions::default().timeout)
        } else if !qjs::JS_IsNumber(timeout) {
            Err(JsError::Type("evaluate's timeout must be a number".into()))
        } else {
            let mut ms = 0f64;
            qjs::JS_ToFloat64(cx, &mut ms, timeout);
            if ms.is_finite() && ms > 0.0 && ms <= u32::MAX as f64 {
                Ok(std::time::Duration::from_secs_f64(ms / 1000.0))
            } else {
                Err(JsError::Range(
                    "evaluate's timeout must be a positive number of milliseconds".into(),
                ))
            }
        }
    };
    // SAFETY: frees the owned property value.
    unsafe { qjs::JS_FreeValue(cx, timeout) };
    result
}

/// `ref.measure()`: a promise of where node `id` is after this turn's
/// layout, which the core answers on the root (`Command::Measure`).
pub(crate) fn measure(cx: *mut JsContext, id: u32) -> JsValue {
    measure_with(cx, id, |call| Command::Measure { call })
}

/// `ref.measureScrollPosition()`: a promise of where list `id`'s viewport
/// starts among its rows after this turn's layout, which the core answers
/// on the root (`Command::MeasureScrollPosition`).
pub(crate) fn measure_scroll_position(cx: *mut JsContext, id: u32) -> JsValue {
    measure_with(cx, id, |call| Command::MeasureScrollPosition { call })
}

/// A promise of the core's answer to `command` (for a new call) on node
/// `id`.
fn measure_with(cx: *mut JsContext, id: u32, command: impl FnOnce(u32) -> Command) -> JsValue {
    let call = next_call(cx);
    if let Err(e) = dom::push_op(
        cx,
        Op::Command {
            id,
            command: command(call),
        },
    ) {
        return e;
    }
    promise(cx, call)
}

/// Delivers what the core hands JS besides nodes' events: a Rust
/// component's event (to its `on<Event>` handler), whether its lazy
/// children are placed, a call's result (its promise settles, the value
/// converted now). `Err`: the exception a handler threw. The Rust code it
/// runs (conversions, drops) cannot unwind out: a panic there is logged,
/// or rejects the call's promise.
pub(crate) fn deliver(cx: *mut JsContext, event: JsEvent) -> Result<(), JsValue> {
    match event {
        JsEvent::Event(..) | JsEvent::LayoutListener { .. } => Ok(()),
        JsEvent::Component { host, event } => {
            let name = event.name();
            let handled = components(cx)
                .handled
                .borrow()
                .get(&host)
                .is_some_and(|names| names.contains(&name));
            if !handled {
                // Dropped here, unconverted: no handler would read it.
                return Ok(());
            }
            let host_js = crate::classes::host_outside_calls(cx);
            let data = catch_unwind(AssertUnwindSafe(move || {
                event.data_js(&host_js).map(|d| d.into_raw())
            }));
            let data = match data {
                Ok(Ok(data)) => data,
                Ok(Err(e)) => {
                    // What a conversion threw (the error says it).
                    let _ = crate::web::js::take_exception(cx);
                    log::error!(target: "js", "the data of event `{name}` did not convert: {e}");
                    return Ok(());
                }
                Err(payload) => {
                    let _ = crate::web::js::take_exception(cx);
                    log::error!(
                        target: "js",
                        "the data of event `{name}` panicked as it converted: {}",
                        crate::classes::panic_message(payload)
                    );
                    return Ok(());
                }
            };
            let data = crate::classes::from_raw(data);
            component_event(cx, host, name, data)
        }
        JsEvent::Children { host, wanted } => {
            let data = if wanted { qjs::JS_TRUE } else { qjs::JS_FALSE };
            component_event(cx, host, CHILDREN, data)
        }
        JsEvent::Render {
            host,
            prop,
            key,
            value,
            func,
        } => {
            let host_js = crate::classes::host_outside_calls(cx);
            let value_spread = value.spread();
            let converted = catch_unwind(AssertUnwindSafe(|| {
                value.render_js(&host_js).map(|v| v.into_raw())
            }));
            let value = match converted {
                Ok(Ok(v)) => crate::classes::from_raw(v),
                Ok(Err(e)) => {
                    let _ = crate::web::js::take_exception(cx);
                    log::error!(target: "js", "the value `{prop}` renders did not convert: {e}");
                    return Ok(());
                }
                Err(payload) => {
                    let _ = crate::web::js::take_exception(cx);
                    log::error!(
                        target: "js",
                        "the value `{prop}` renders panicked as it converted: {}",
                        crate::classes::panic_message(payload)
                    );
                    return Ok(());
                }
            };
            if let Some(func) = func {
                return fn_render(cx, host, &format!("{prop}\u{1f}{key}"), value, &*func);
            }
            let data = render_data(cx, prop, &key);
            let spread = if value_spread {
                qjs::JS_TRUE
            } else {
                qjs::JS_FALSE
            };
            // SAFETY: the object takes the value.
            unsafe {
                qjs::JS_SetPropertyStr(cx, data, c"value".as_ptr(), value);
                qjs::JS_SetPropertyStr(cx, data, c"spread".as_ptr(), spread);
            }
            component_event(cx, host, RENDER, data)
        }
        JsEvent::Unrender { host, prop, key } => {
            let slot = format!("{prop}\u{1f}{key}");
            let taken = components(cx).fn_renders.borrow_mut().remove(&(host, slot));
            if let Some(r) = taken {
                return fn_unrender(cx, host, r);
            }
            let data = render_data(cx, prop, &key);
            component_event(cx, host, UNRENDER, data)
        }
        JsEvent::Rows(ids) => dom::render_rows(cx, &ids),
        JsEvent::Reply { call, result } => settle(cx, call, result),
    }
}

/// The name of the event placing lazy children (no component's event
/// has a `$`).
const CHILDREN: &str = "$children";
/// The events rendering a render function's content for a key, and
/// releasing it.
const RENDER: &str = "$render";
const UNRENDER: &str = "$unrender";

/// `{ prop, key }` (owned).
fn render_data(ctx: *mut JsContext, prop: &str, key: &str) -> JsValue {
    // SAFETY: a new object taking new strings.
    unsafe {
        let data = qjs::JS_NewObject(ctx);
        qjs::JS_SetPropertyStr(ctx, data, c"prop".as_ptr(), new_string(ctx, prop));
        qjs::JS_SetPropertyStr(ctx, data, c"key".as_ptr(), new_string(ctx, key));
        data
    }
}

/// Renders `value` (owned) with `func`, a function component host `host`
/// holds itself, for `slot`: the first time, `func` gets props reading
/// the value's signal, its content goes into a new holder inserted into
/// the host (rendered under the owner the host was made under, so it
/// sees the context around the host, as on the web); after that the signal takes the value (nothing is made
/// again).
fn fn_render(
    cx: *mut JsContext,
    host: nsh_core::NodeId,
    slot: &str,
    value: JsValue,
    func: &dyn nsh_core::element::CallbackHandle,
) -> Result<(), JsValue> {
    let value = Owned(cx, value);
    let key = (host, slot.to_owned());
    if let Some(r) = components(cx).fn_renders.borrow().get(&key) {
        reactive::set_signal(cx, r.value, value.take());
        return Ok(());
    }
    let js_host = crate::classes::host_outside_calls(cx);
    let Some(f) = func.value(&js_host) else {
        return Ok(());
    };
    let f = Owned(cx, crate::classes::from_raw(f));
    let props_of = props_of(cx)?;
    let signal = Owned(cx, reactive::new_signal(cx, value.1));
    // Under the owner the host was made under: the content sees the
    // context around the component, as its children would.
    let owner = dom::owner_of_node(cx, host);
    let (root, made) = reactive::untracked_with(cx, || {
        reactive::with_root_under(cx, owner, || -> Result<Owned, JsValue> {
            let props = Owned(
                cx,
                crate::web::js::call(cx, props_of, UNDEFINED, &[signal.1])
                    .map(|v| v.take())
                    .map_err(|_| qjs::JS_EXCEPTION)?,
            );
            let holder = Owned(cx, dom::create_element(cx, nsh_core::Tag::View)?);
            let name = Owned(cx, new_string(cx, slot));
            dom::set_prop_value(cx, holder.1, "componentRender", name.1)?;
            let content = Owned(
                cx,
                crate::web::js::call(cx, f.1, UNDEFINED, &[props.1])
                    .map(|v| v.take())
                    .map_err(|_| qjs::JS_EXCEPTION)?,
            );
            dom::insert_value_at(cx, holder.1, content.1, None)?;
            Ok(holder)
        })
    });
    let holder = match made {
        Ok(holder) => holder,
        Err(e) => {
            reactive::dispose_owner(cx, root);
            return Err(e);
        }
    };
    let node = Owned(cx, dom::node_value(cx, host));
    dom::insert_node(cx, node.1, holder.1, None)?;
    components(cx).fn_renders.borrow_mut().insert(
        key,
        FnRender {
            holder: holder.take(),
            root,
            value: signal.take(),
        },
    );
    Ok(())
}

/// What a component's own function rendered goes: its root is disposed,
/// its holder leaves the host.
fn fn_unrender(cx: *mut JsContext, host: nsh_core::NodeId, r: FnRender) -> Result<(), JsValue> {
    let holder = Owned(cx, r.holder);
    drop(Owned(cx, r.value));
    reactive::dispose_owner(cx, r.root);
    let node = Owned(cx, dom::node_value(cx, host));
    dom::remove_node(cx, node.1, holder.1)
}

/// The function making the props a component's own function renders
/// with: `(read) => props`, each property read from the latest value of
/// signal `read` (a method bound to it), so what reads them follows it.
/// Borrowed (the components' state owns it).
fn props_of(cx: *mut JsContext) -> Result<JsValue, JsValue> {
    let state = components(cx);
    if let Some(made) = state.props_of.get() {
        return Ok(made);
    }
    const SOURCE: &str = "(read) => new Proxy({}, {\n\
        get(_, key) { const value = read(); const field = value == null ? undefined : value[key]; return typeof field === \"function\" ? field.bind(value) : field; },\n\
        has(_, key) { const value = read(); return value != null && key in Object(value); },\n\
        getPrototypeOf() { const value = read(); return value == null ? null : Object.getPrototypeOf(Object(value)); },\n\
      })\0";
    // SAFETY: a NUL-terminated script evaluated in the context.
    let f = unsafe {
        qjs::JS_Eval(
            cx,
            SOURCE.as_ptr().cast(),
            (SOURCE.len() - 1) as _,
            c"<nsh:props>".as_ptr(),
            qjs::JS_EVAL_TYPE_GLOBAL as c_int,
        )
    };
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(f) } {
        return Err(qjs::JS_EXCEPTION);
    }
    state.props_of.set(Some(f));
    Ok(f)
}

/// `(read) => () => f(v)`: a reactive child calling, untracked, the
/// function `f` of the `[f, v]` signal `read` holds with value `v`, its
/// content made again each time the signal changes.
fn call_of(cx: *mut JsContext) -> Result<JsValue, JsValue> {
    let state = components(cx);
    if let Some(made) = state.call_of.get() {
        return Ok(made);
    }
    const SOURCE: &str = "(untrack) => (read) => () => { const [f, v, s] = read(); return untrack(() => s ? f(...v) : f(v)); }\0";
    // SAFETY: a NUL-terminated script evaluated in the context.
    let make = Owned(cx, unsafe {
        qjs::JS_Eval(
            cx,
            SOURCE.as_ptr().cast(),
            (SOURCE.len() - 1) as _,
            c"<nsh:call>".as_ptr(),
            qjs::JS_EVAL_TYPE_GLOBAL as c_int,
        )
    });
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(make.1) } {
        return Err(qjs::JS_EXCEPTION);
    }
    let untrack = Owned(
        cx,
        reactive::new_function(cx, c"untrack", reactive::untrack, 1),
    );
    let f = crate::web::js::call(cx, make.1, UNDEFINED, &[untrack.1])
        .map(|v| v.take())
        .map_err(|_| qjs::JS_EXCEPTION)?;
    state.call_of.set(Some(f));
    Ok(f)
}

/// Calls the native-event handler of Rust component host `host` with
/// `{ name, data }` (`data` taken).
fn component_event(
    cx: *mut JsContext,
    host: nsh_core::NodeId,
    name: &str,
    data: JsValue,
) -> Result<(), JsValue> {
    let handler = dom::handler(cx, host, EventKind::NativeEvent).map(|value| Owned(cx, value));
    let Some(handler) = handler else {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, data) };
        return Ok(());
    };
    // SAFETY: a new object taking the name and the data; the handler and
    // the object are ours, freed after the call.
    unsafe {
        let event = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, event, c"name".as_ptr(), new_string(cx, name));
        qjs::JS_SetPropertyStr(cx, event, c"data".as_ptr(), data);
        let mut args = [event];
        let r = qjs::JS_Call(cx, handler.1, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, event);
        if qjs::JS_IsException(r) {
            return Err(r);
        }
        qjs::JS_FreeValue(cx, r);
    }
    Ok(())
}

/// Settles call `call` with `result`: resolved with the value (converted
/// now), or rejected with its error (a [`nsh_core::element::JsError`]'s class
/// and properties; an `Error` of the message when the value does not
/// convert, or its conversion panics).
fn settle(cx: *mut JsContext, call: u32, result: JsResult) -> Result<(), JsValue> {
    let pending = components(cx).pending.borrow_mut().remove(&call);
    // Nobody waits (the promise's VM state was reset): the value drops,
    // its `Drop` (the app's code) caught.
    let Some((resolve, reject)) = pending else {
        if let Err(payload) = catch_unwind(AssertUnwindSafe(move || drop(result))) {
            log::error!(
                target: "js",
                "a call's result panicked as it dropped: {}",
                crate::classes::panic_message(payload)
            );
        }
        return Ok(());
    };
    // Owned from here: freed whatever happens.
    let (resolve, reject) = (V::own(cx, resolve), V::own(cx, reject));
    let host = crate::classes::host_outside_calls(cx);
    let converted = catch_unwind(AssertUnwindSafe(|| {
        result.and_then(|value| {
            value
                .to_js_value(&host)
                .map(|v| V::own(cx, crate::classes::from_raw(v.into_raw())))
                .map_err(|e| nsh_core::element::Thrown::Error(e.0))
        })
    }))
    .unwrap_or_else(|payload| Err(crate::classes::panic_message(payload).into()));
    let (f, value) = match converted {
        Ok(value) => (resolve, value),
        Err(thrown) => {
            host.clear_pending();
            (reject, crate::classes::error_value(cx, &thrown))
        }
    };
    match crate::web::js::call(cx, f.raw(), UNDEFINED, &[value.raw()]) {
        Ok(_) => Ok(()),
        Err(_) => Err(qjs::JS_EXCEPTION),
    }
}

// --- Modules ------------------------------------------------------------------------

/// A function of a module: one that runs in the JS call, or one sending
/// what it runs to the core.
pub(crate) fn module_function(cx: *mut JsContext, module: &ModuleSpec, function: &str) -> JsValue {
    let Some(spec) = module.functions.iter().find(|f| f.name == function) else {
        return UNDEFINED;
    };
    let length = spec.params.len();
    let (f, opaque): (qjs::JSCClosure, *const ()) = match spec.call {
        FunctionCall::Sync(f) => return crate::classes::sync_function(cx, function, f, length),
        FunctionCall::Op(make) => (Some(call_op), make as *const ()),
        FunctionCall::Async(start) => (Some(call_task), start as *const ()),
        FunctionCall::Start(start) => (Some(call_start), start as *const ()),
    };
    let name = CString::new(function).unwrap_or_default();
    // SAFETY: the opaque is the function's conversion (a function pointer,
    // as large as a data pointer on every target), which needs no
    // finalizer; the magic says whether it returns a promise.
    unsafe {
        qjs::JS_NewCClosure(
            cx,
            f,
            name.as_ptr(),
            None,
            length as c_int,
            c_int::from(spec.promises()),
            opaque as *mut std::ffi::c_void,
        )
    }
}

/// The conversion of a module function with a context.
type MakeOp = fn(
    &dyn nsh_core::element::JsHost,
) -> Result<nsh_core::element::OpCall, nsh_core::element::Thrown>;

unsafe extern "C" fn call_op(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    opaque: *mut std::ffi::c_void,
) -> JsValue {
    // SAFETY: `module_function` made the opaque from a `MakeOp`, and
    // QuickJS passes `argc` live arguments.
    let (make, args) = unsafe {
        (
            std::mem::transmute::<*const (), MakeOp>(opaque as *const ()),
            crate::web::js::Args::new(argc, argv),
        )
    };
    crate::classes::send(cx, this, args, magic != 0, |host| {
        make(host).map(RustCall::Op)
    })
}

unsafe extern "C" fn call_task(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    opaque: *mut std::ffi::c_void,
) -> JsValue {
    // SAFETY: `module_function` made the opaque from an `AsyncCall`, and
    // QuickJS passes `argc` live arguments.
    let (start, args) = unsafe {
        (
            std::mem::transmute::<*const (), nsh_core::element::AsyncCall>(opaque as *const ()),
            crate::web::js::Args::new(argc, argv),
        )
    };
    crate::classes::send(cx, this, args, true, |host| start(host).map(RustCall::Task))
}

/// A function starting its task in the JS call (`Later`): what the start
/// refuses rejects, as every call returning a promise.
unsafe extern "C" fn call_start(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    opaque: *mut std::ffi::c_void,
) -> JsValue {
    // SAFETY: `module_function` made the opaque from an `AsyncCall`, and
    // QuickJS passes `argc` live arguments.
    let (start, args) = unsafe {
        (
            std::mem::transmute::<*const (), nsh_core::element::AsyncCall>(opaque as *const ()),
            crate::web::js::Args::new(argc, argv),
        )
    };
    crate::classes::send(cx, this, args, true, |host| start(host).map(RustCall::Task))
}

/// A module's object: its functions.
pub(crate) fn module(cx: *mut JsContext, module: &ModuleSpec) -> JsValue {
    // SAFETY: a new object taking the functions.
    let obj = unsafe { qjs::JS_NewObject(cx) };
    add_functions(cx, obj, module);

    obj
}

/// Puts `module`'s functions, getters and constants on `obj`.
pub(crate) fn add_functions(cx: *mut JsContext, obj: JsValue, module: &ModuleSpec) {
    for f in &module.functions {
        let func = module_function(cx, module, f.name);
        let name = CString::new(f.name).unwrap_or_default();
        if f.getter {
            // SAFETY: an accessor of the object, which takes the getter.
            unsafe {
                let atom = qjs::JS_NewAtom(cx, name.as_ptr());
                qjs::JS_DefinePropertyGetSet(
                    cx,
                    obj,
                    atom,
                    func,
                    UNDEFINED,
                    (qjs::JS_PROP_ENUMERABLE | qjs::JS_PROP_CONFIGURABLE) as c_int,
                );
                qjs::JS_FreeAtom(cx, atom);
            }
            continue;
        }
        // SAFETY: the object takes the function.
        unsafe { qjs::JS_SetPropertyStr(cx, obj, name.as_ptr(), func) };
    }
    for constant in &module.constants {
        use nsh_core::element::ConstantValue;
        let value = match constant.value {
            ConstantValue::Undefined => UNDEFINED,
            ConstantValue::String(value) => new_string(cx, value),
            ConstantValue::Number(value) => qjs::JS_NewFloat64(value),
            ConstantValue::Bool(value) => {
                if value {
                    qjs::JS_TRUE
                } else {
                    qjs::JS_FALSE
                }
            }
        };
        let name = CString::new(constant.name).unwrap_or_default();
        // SAFETY: this live module object takes ownership of the newly
        // created primitive; its constant name is NUL-terminated.
        unsafe {
            qjs::JS_SetPropertyStr(cx, obj, name.as_ptr(), value);
        }
    }
}

/// The object of module `module` of the runtime registry `specifier`
/// (owned), if there is one.
pub(crate) fn runtime_module(cx: *mut JsContext, specifier: &str, module: &str) -> Option<JsValue> {
    let registry = nsh_core::runtime::registries()
        .iter()
        .find(|r| r.specifier() == Some(specifier))?;
    let spec = registry
        .module_specs()
        .into_iter()
        .find(|m| m.name == module)?;
    Some(self::module(cx, &spec))
}

/// Puts the functions of module `module` of the runtime registry
/// `specifier` on `obj` (`Image.getSize` on `nsh`'s `Image`).
pub(crate) fn add_runtime_functions(
    cx: *mut JsContext,
    obj: JsValue,
    specifier: &str,
    module: &str,
) {
    let Some(registry) = nsh_core::runtime::registries()
        .iter()
        .find(|r| r.specifier() == Some(specifier))
    else {
        return;
    };
    if let Some(spec) = registry
        .module_specs()
        .into_iter()
        .find(|m| m.name == module)
    {
        add_functions(cx, obj, &spec);
    }
}

// --- Components --------------------------------------------------------------------

/// The function rendering component `spec` (with the functions of a module
/// of the same name on it).
pub(crate) fn component(
    cx: *mut JsContext,
    spec: Arc<ComponentSpec>,
    module: Option<Arc<ModuleSpec>>,
) -> JsValue {
    let c = components(cx);
    let index = {
        let mut specs = c.specs.borrow_mut();
        specs.push(spec);
        specs.len() - 1
    };
    let mut data = [qjs::JS_NewFloat64(index as f64)];
    // SAFETY: the function keeps a dup of `data`.
    let f = unsafe { qjs::JS_NewCFunctionData(cx, Some(render), 1, 0, 1, data.as_mut_ptr()) };
    if let Some(module) = module {
        add_functions(cx, f, &module);
    }
    f
}

fn spec_of(cx: *mut JsContext, data: *mut JsValue) -> Arc<ComponentSpec> {
    spec_at(cx, spec_index(cx, data))
}

fn spec_at(cx: *mut JsContext, index: usize) -> Arc<ComponentSpec> {
    components(cx).specs.borrow()[index].clone()
}

/// The spec index a component's function data holds.
fn spec_index(cx: *mut JsContext, data: *mut JsValue) -> usize {
    let mut index = 0f64;
    // SAFETY: one data value, a number (`component`).
    unsafe { qjs::JS_ToFloat64(cx, &mut index, *data) };
    index as usize
}

/// The props the effect of the component of spec `index` reads, made the
/// first time; `None` with an exception pending when an atom could not be
/// made (nothing is kept, so the next run tries again).
fn prop_keys(cx: *mut JsContext, index: usize, spec: &ComponentSpec) -> Option<Rc<[PropKey]>> {
    let c = components(cx);
    if let Some(Some(keys)) = c.prop_keys.borrow().get(index) {
        return Some(keys.clone());
    }
    let mut keys: Vec<PropKey> = Vec::new();
    let names = spec
        .props
        .iter()
        .filter(|p| matches!(p.kind, PropKind::Value | PropKind::Renderer))
        .map(|p| (p.name, p.decode))
        .chain(spec.host_props().map(|h| (h, None)));
    for (name, decode) in names {
        // SAFETY: a new atom, owned by the table (or freed below).
        let atom = unsafe { qjs::JS_NewAtomLen(cx, name.as_ptr().cast(), name.len() as _) };
        if atom == qjs::JS_ATOM_NULL {
            for key in &keys {
                // SAFETY: the atoms made above.
                unsafe { qjs::JS_FreeAtom(cx, key.atom) };
            }
            return None;
        }
        keys.push(PropKey { name, atom, decode });
    }
    let keys: Rc<[PropKey]> = keys.into();
    let mut all = c.prop_keys.borrow_mut();
    if all.len() <= index {
        all.resize(index + 1, None);
    }
    all[index] = Some(keys.clone());
    Some(keys)
}

/// A function returning `props[key]` (read when the renderer calls it).
fn prop_reader(cx: *mut JsContext, props: JsValue, key: &str) -> JsValue {
    let mut data = [props, new_string(cx, key)];
    // SAFETY: the function keeps dups of `data`; our string is freed.
    unsafe {
        let f = qjs::JS_NewCFunctionData(cx, Some(read_prop), 0, 0, 2, data.as_mut_ptr());
        qjs::JS_FreeValue(cx, data[1]);
        f
    }
}

unsafe extern "C" fn read_prop(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`prop_reader`): the props and the key, a
    // string; the atom is freed.
    unsafe {
        let (props, key) = (*data, *data.add(1));
        if !qjs::JS_IsObject(props) {
            return UNDEFINED;
        }
        let atom = qjs::JS_ValueToAtom(cx, key);
        if atom == qjs::JS_ATOM_NULL {
            return qjs::JS_EXCEPTION;
        }
        let v = qjs::JS_GetProperty(cx, props, atom);
        qjs::JS_FreeAtom(cx, atom);
        v
    }
}

/// Renders a Rust component: `render(props)` is the component's function.
unsafe extern "C" fn render(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let spec = spec_of(cx, data);
    let props = arg(argc, argv, 0);
    match render_component(cx, &spec, props, data) {
        Ok(node) => reactive::finish_value(cx, node),
        Err(e) => e,
    }
}

fn render_component(
    cx: *mut JsContext,
    spec: &ComponentSpec,
    props: JsValue,
    spec_data: *mut JsValue,
) -> Result<JsValue, JsValue> {
    let node = dom::create_element(cx, nsh_core::Tag::View)?;
    let guard = Owned(cx, node);
    let name = new_string(cx, spec.name);
    let r = dom::set_prop_value(cx, node, "component", name);
    // SAFETY: ours.
    unsafe { qjs::JS_FreeValue(cx, name) };
    r?;
    // One holder per slot the app fills (props are fixed per JSX site).
    let mut anchor: Option<Owned> = None;
    for slot in spec.slots() {
        if !has(cx, props, slot) {
            continue;
        }
        let holder = Owned(cx, dom::create_element(cx, nsh_core::Tag::View)?);
        let slot_name = new_string(cx, slot);
        let r = dom::set_prop_value(cx, holder.1, "componentSlot", slot_name);
        unsafe { qjs::JS_FreeValue(cx, slot_name) };
        r?;
        let reader = Owned(cx, prop_reader(cx, props, slot));
        dom::insert_value_at(cx, holder.1, reader.1, None)?;
        dom::insert_node(cx, node, holder.1, None)?;
        if anchor.is_none() {
            anchor = Some(holder);
        }
    }
    // A component with rows: a list of the app's data and row renderer as
    // that slot (only what the app passes: the list checks which slots
    // exist); the component lays it out and wraps the rows.
    if let Some(items) = spec.items() {
        // SAFETY: a new object with getters reading the app's props.
        let forwarded = Owned(cx, unsafe { qjs::JS_NewObject(cx) });
        for key in crate::list::ITEMS_PROPS {
            if !has(cx, props, key) {
                continue;
            }
            let getter = prop_reader(cx, props, key);
            let k = CString::new(*key).unwrap_or_default();
            unsafe {
                let atom = qjs::JS_NewAtom(cx, k.as_ptr());
                qjs::JS_DefineProperty(
                    cx,
                    forwarded.1,
                    atom,
                    UNDEFINED,
                    getter,
                    UNDEFINED,
                    (qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_ENUMERABLE | qjs::JS_PROP_ENUMERABLE)
                        as c_int,
                );
                qjs::JS_FreeAtom(cx, atom);
                qjs::JS_FreeValue(cx, getter);
            }
        }
        let holder = Owned(cx, crate::list::render(cx, forwarded.1)?);
        let slot_name = new_string(cx, items);
        let r = dom::set_prop_value(cx, holder.1, "componentSlot", slot_name);
        unsafe { qjs::JS_FreeValue(cx, slot_name) };
        r?;
        dom::insert_node(cx, node, holder.1, None)?;
        if anchor.is_none() {
            anchor = Some(holder);
        }
    }
    // The ref of a component with methods: an object calling them.
    let api = if spec.methods.is_empty() {
        None
    } else {
        // SAFETY: a new object holding the node and the methods.
        let api = Owned(cx, unsafe { qjs::JS_NewObject(cx) });
        unsafe {
            qjs::JS_SetPropertyStr(cx, api.1, c"node".as_ptr(), qjs::JS_DupValue(cx, node));
        }
        for (i, m) in spec.methods.iter().enumerate() {
            // The node, the spec's index, the method's.
            let mut mdata = [
                node,
                // SAFETY: the spec's index (a number).
                unsafe { qjs::JS_DupValue(cx, *spec_data) },
                qjs::JS_NewFloat64(i as f64),
            ];
            let name = CString::new(m.name).unwrap_or_default();
            // SAFETY: the function keeps dups of `mdata`; the object takes it.
            unsafe {
                let f = qjs::JS_NewCFunctionData(
                    cx,
                    Some(call_method),
                    m.params.len() as c_int,
                    0,
                    3,
                    mdata.as_mut_ptr(),
                );
                qjs::JS_FreeValue(cx, mdata[1]);
                qjs::JS_SetPropertyStr(cx, api.1, name.as_ptr(), f);
            }
        }
        Some(api)
    };
    let handled: Box<[&'static str]> = spec
        .events
        .iter()
        .filter(|e| has_atom(cx, props, handler_atom(cx, e.name)))
        .map(|e| e.name)
        .collect();
    let handles_events = !handled.is_empty();
    if handles_events {
        let id = dom::node_id(cx, node).unwrap_or(0);
        components(cx).handled.borrow_mut().insert(id, handled);
        let mut cdata = [qjs::JS_NewFloat64(id as f64)];
        // SAFETY: the function keeps a dup of `cdata`; the owner takes it.
        let cleanup = unsafe {
            qjs::JS_NewCFunctionData(cx, Some(forget_handled), 0, 0, 1, cdata.as_mut_ptr())
        };
        reactive::add_cleanup(cx, cleanup);
    }
    // Lazy children: made while this signal (the core's `$children`) is
    // true.
    let lazy = (spec.lazy_children && spec.takes_children() && has(cx, props, "children"))
        .then(|| Owned(cx, reactive::new_signal(cx, qjs::JS_FALSE)));
    // Render functions: what they rendered, by (prop, key): `[holder,
    // root]`, the roots disposed with the component.
    let renders = spec
        .renderers()
        .any(|r| has(cx, props, r))
        // SAFETY: a new object.
        .then(|| Owned(cx, unsafe { qjs::JS_NewObject(cx) }));
    if let Some(renders) = &renders {
        let mut cdata = [renders.1];
        // SAFETY: the function keeps a dup of `cdata`; the owner takes it.
        let cleanup = unsafe {
            qjs::JS_NewCFunctionData(cx, Some(dispose_renders), 0, 0, 1, cdata.as_mut_ptr())
        };
        reactive::add_cleanup(cx, cleanup);
    }
    if handles_events || lazy.is_some() || renders.is_some() {
        let id = dom::node_id(cx, node).unwrap_or(0);
        let mut edata = [
            props,
            lazy.as_ref().map_or(UNDEFINED, |l| l.1),
            renders.as_ref().map_or(UNDEFINED, |r| r.1),
            qjs::JS_NewFloat64(id as f64),
            qjs::JS_NewFloat64(reactive::current_owner(cx) as f64),
        ];
        // SAFETY: the function keeps dups of `edata`.
        let on = Owned(cx, unsafe {
            qjs::JS_NewCFunctionData(cx, Some(on_native_event), 1, 0, 5, edata.as_mut_ptr())
        });
        dom::set_handler(cx, id, EventKind::NativeEvent, on.1)?;
    }
    // One effect reads every prop and sends those that changed.
    let mut pdata = [
        node,
        props,
        // SAFETY: a new array of the previous values (filled by the runs).
        unsafe { qjs::JS_NewArray(cx) },
        // SAFETY: the spec's index (a number).
        unsafe { qjs::JS_DupValue(cx, *spec_data) },
    ];
    // SAFETY: the function keeps dups of `pdata`; ours are freed.
    let func = unsafe {
        let f = qjs::JS_NewCFunctionData(cx, Some(props_run), 0, 0, 4, pdata.as_mut_ptr());
        qjs::JS_FreeValue(cx, pdata[2]);
        f
    };
    let r = reactive::render_effect(cx, func);
    // SAFETY: the effect's value is unused.
    unsafe { qjs::JS_FreeValue(cx, r) };
    let ref_ = get(cx, props, "ref");
    // SAFETY: a live value; called untracked with the ref.
    if unsafe { qjs::JS_IsFunction(cx, ref_) } {
        let target = api.as_ref().map_or(node, |a| a.1);
        let r = match dom::apply_ref(cx, ref_, target) {
            Ok(_) => UNDEFINED,
            Err(e) => e,
        };
        unsafe {
            qjs::JS_FreeValue(cx, ref_);
            if qjs::JS_IsException(r) {
                return Err(r);
            }
            qjs::JS_FreeValue(cx, r);
        }
    } else {
        unsafe { qjs::JS_FreeValue(cx, ref_) };
    }
    // Before the slots' holders: clearing the children must not remove
    // them.
    if spec.takes_children() && has(cx, props, "children") {
        let reader = Owned(cx, prop_reader(cx, props, "children"));
        let children = match &lazy {
            Some(shown) => {
                let c = Owned(cx, dom::cond_value(cx, shown.1, reader.1));
                // SAFETY: a live value.
                if unsafe { qjs::JS_IsException(c.1) } {
                    return Err(c.take());
                }
                c
            }
            // A memo of the getter: it runs again only when what the
            // children's expression itself reads changes, not each time
            // what they show does, so the regions it makes (an `<Each>`'s
            // rows) are made once and kept, as a host element's are.
            None => {
                let memo = reactive::memo(cx, reader.take(), false);
                Owned(cx, reactive::finish_value(cx, memo))
            }
        };
        dom::insert_value_at(cx, node, children.1, anchor.as_ref().map(|a| a.1))?;
    }
    Ok(guard.take())
}

/// A JS value owned until dropped (or taken).
struct Owned(*mut JsContext, JsValue);

impl Owned {
    fn take(self) -> JsValue {
        let v = self.1;
        std::mem::forget(self);
        v
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(self.0, self.1) };
    }
}

/// A run of a component's props effect: sends the props that changed.
unsafe extern "C" fn props_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: four data values (`render_component`).
    let (node, props, prev, index) = unsafe { (*data, *data.add(1), *data.add(2), data.add(3)) };
    let index = spec_index(cx, index);
    let spec = spec_at(cx, index);
    let Some(keys) = prop_keys(cx, index, &spec) else {
        return qjs::JS_EXCEPTION;
    };
    // Every prop is read and set whatever another one did, so each stays
    // tracked and the good ones reach the view; the first error is thrown
    // at the end (an uncatchable one, an interrupt, at once).
    let mut first: Option<V> = None;
    let failed = |first: &mut Option<V>| -> bool {
        let e = crate::web::js::take_exception(cx);
        // SAFETY: a check of a live value.
        if unsafe { qjs::JS_IsUncatchableError(e.raw()) } {
            let _ = crate::web::js::throw(cx, e);
            return true;
        }
        first.get_or_insert(e);
        false
    };
    for (i, k) in keys.iter().enumerate() {
        let (key, decode) = (k.name, k.decode);
        let value = get_atom(cx, props, k.atom);
        // SAFETY: live values; the array keeps a dup of the new value.
        unsafe {
            if qjs::JS_IsException(value) {
                if failed(&mut first) {
                    return qjs::JS_EXCEPTION;
                }
                continue;
            }
            let old = qjs::JS_GetPropertyUint32(cx, prev, i as u32);
            let same = qjs::JS_IsStrictEqual(cx, old, value);
            let result = if same {
                Ok(())
            } else if let Some(decode) = decode {
                set_rust_prop(cx, node, &spec, key, decode, value)
            } else {
                dom::set_prop_with_prev(cx, node, key, value, old)
            };
            qjs::JS_FreeValue(cx, old);
            // The previous value is what the view has: one that was not
            // sent (it did not convert) leaves it, so assigning it again
            // throws again and `undefined` resets the prop.
            if result.is_err() {
                qjs::JS_FreeValue(cx, value);
                if failed(&mut first) {
                    return qjs::JS_EXCEPTION;
                }
                continue;
            }
            qjs::JS_SetPropertyUint32(cx, prev, i as u32, value);
        }
    }
    match first {
        Some(e) => {
            let _ = crate::web::js::throw(cx, e);
            qjs::JS_EXCEPTION
        }
        None => UNDEFINED,
    }
}

/// Sets prop `key` of the Rust component on `node` to `value` (borrowed),
/// converted into the prop's type now. A value of another type is a
/// warning, as a host element's is (`Gauge.level: expected ...`), and the
/// prop keeps its value (its default in the first render); `undefined`
/// resets it to its default. A getter that throws, or a decoder's panic,
/// throws.
fn set_rust_prop(
    cx: *mut JsContext,
    node: JsValue,
    spec: &ComponentSpec,
    key: &'static str,
    decode: nsh_core::element::PropDecode,
    value: JsValue,
) -> Result<(), JsValue> {
    let Some(id) = dom::node_id(cx, node) else {
        return Ok(());
    };
    // SAFETY: an inline tag check.
    let decoded = if unsafe { qjs::JS_IsUndefined(value) } {
        None
    } else {
        let host = crate::classes::host_outside_calls(cx);
        // The app's conversion: a panic in it throws, as in a call.
        // A render function is this component's.
        let decoded = catch_unwind(AssertUnwindSafe(|| {
            nsh_core::element::__decoding_props_of(id, || {
                decode(JsIn::new(&host, crate::classes::to_raw(value)))
            })
        }));
        let decoded = match decoded {
            Ok(decoded) => decoded,
            Err(payload) => {
                host.clear_pending();
                let message = crate::classes::panic_message(payload);
                let _ =
                    crate::classes::throw_error(cx, &format!("{}.{key}: {message}", spec.export));
                return Err(qjs::JS_EXCEPTION);
            }
        };
        match decoded {
            Ok(v) => {
                host.clear_pending();
                Some(v)
            }
            // A getter threw: its exception goes on.
            Err(_) if host.has_pending() => return Err(qjs::JS_EXCEPTION),
            Err(e) => {
                dom::warn(cx, format!("{}.{key}: {e}", spec.export));
                return Ok(());
            }
        }
    };
    dom::push_op(
        cx,
        Op::SetProp {
            id,
            prop: Prop::RustProp(key, decoded),
        },
    )
}

unsafe extern "C" fn call_method(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (`render_component`): the node, the
    // spec's index and the method's.
    let (node, spec, index) = unsafe { (*data, data.add(1), *data.add(2)) };
    let spec = spec_of(cx, spec);
    let mut i = 0f64;
    // SAFETY: a number (`render_component`).
    unsafe { qjs::JS_ToFloat64(cx, &mut i, index) };
    let (Some(id), Some(method)) = (dom::node_id(cx, node), spec.methods.get(i as usize)) else {
        return qjs::JS_EXCEPTION;
    };
    // SAFETY: QuickJS passes `argc` live arguments.
    let args = unsafe { crate::web::js::Args::new(argc, argv) };
    let make = method.call;
    // A wrong argument's error names the component (`Stepper.setValue`).
    crate::classes::send(cx, this, args, method.promises(), |host| {
        make(host)
            .map(|call| RustCall::Method(id, call))
            .map_err(|e| match e {
                nsh_core::element::Thrown::Type(m) => {
                    nsh_core::element::Thrown::Type(format!("{}.{m}", spec.export))
                }
                other => other,
            })
    })
}

/// A component's events ([`deliver`]): `$children` places its lazy
/// children, `$render` / `$unrender` render a render function's content
/// for a key and release it, others go to the `on<Event>` handler of the
/// props.
unsafe extern "C" fn on_native_event(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: five data values (the props, the lazy children's signal, the
    // renders, the host's id and the owner it was rendered under).
    let (props, lazy, renders, host, owner) = unsafe {
        (
            *data,
            *data.add(1),
            *data.add(2),
            *data.add(3),
            *data.add(4),
        )
    };
    /// What an event's name asks for.
    enum Named {
        Children,
        /// `$render` (true) or `$unrender`.
        Render(bool),
        /// The handler prop's atom.
        Handler(qjs::JSAtom),
    }
    let event = arg(argc, argv, 0);
    let name = get(cx, event, "name");
    let named = dom::with_str(cx, name, |n| match n {
        CHILDREN => Named::Children,
        RENDER => Named::Render(true),
        UNRENDER => Named::Render(false),
        n => Named::Handler(handler_atom(cx, n)),
    });
    // SAFETY: ours.
    unsafe { qjs::JS_FreeValue(cx, name) };
    let Some(named) = named else {
        return qjs::JS_EXCEPTION;
    };
    let atom = match named {
        Named::Children => {
            // SAFETY: an inline tag check; the signal takes the data.
            if !unsafe { qjs::JS_IsUndefined(lazy) } {
                reactive::set_signal(cx, lazy, get(cx, event, "data"));
            }
            return UNDEFINED;
        }
        Named::Render(render) => {
            // SAFETY: an inline tag check.
            if unsafe { qjs::JS_IsUndefined(renders) } {
                return UNDEFINED;
            }
            let (mut host_id, mut owner_id) = (0f64, 0f64);
            // SAFETY: numbers (`render_component`).
            unsafe {
                qjs::JS_ToFloat64(cx, &mut host_id, host);
                qjs::JS_ToFloat64(cx, &mut owner_id, owner);
            }
            let data = Owned(cx, get(cx, event, "data"));
            let state = Renders {
                props,
                renders,
                host: host_id as nsh_core::NodeId,
                owner: owner_id as u32,
            };
            let r = if render {
                state.render(cx, data.1)
            } else {
                state.unrender(cx, data.1)
            };
            return match r {
                Ok(()) => UNDEFINED,
                Err(e) => e,
            };
        }
        Named::Handler(atom) => atom,
    };
    if atom == qjs::JS_ATOM_NULL {
        return qjs::JS_EXCEPTION;
    }
    let handler = get_atom(cx, props, atom);
    // SAFETY: values got are freed; the handler is called with the data.
    unsafe {
        if !qjs::JS_IsFunction(cx, handler) {
            qjs::JS_FreeValue(cx, handler);
            return UNDEFINED;
        }
        // One argument: the event's data, one object (`api-naming.md`
        // "Payloads").
        let mut args = [get(cx, event, "data")];
        let r = qjs::JS_Call(cx, handler, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, args[0]);
        qjs::JS_FreeValue(cx, handler);
        r
    }
}

// --- Render functions ----------------------------------------------------------------

/// A component's render functions: its props, what they rendered by
/// (prop, key) (`[holder, root, signal]`, the signal holding the function
/// and the value its content was made of), its host and the owner it was
/// rendered under (what is rendered sees its context).
struct Renders {
    props: JsValue,
    renders: JsValue,
    host: nsh_core::NodeId,
    owner: u32,
}

impl Renders {
    /// `{ prop, key, value }`: the app's function renders `value` for
    /// (prop, key). The first time, into a new holder inserted into the
    /// host; after that, into the same holder: what the function made for
    /// the last value goes, and it is called again with this one. A
    /// component placing one key per view it reuses (a table's cell
    /// showing another row) keeps one holder per view.
    fn render(&self, ctx: *mut JsContext, data: JsValue) -> Result<(), JsValue> {
        let (Some(prop), Some(key)) = (
            string_arg(ctx, Owned(ctx, get(ctx, data, "prop")).1),
            string_arg(ctx, Owned(ctx, get(ctx, data, "key")).1),
        ) else {
            return Ok(());
        };
        let f = Owned(ctx, get(ctx, self.props, &prop));
        // SAFETY: a live value.
        if !unsafe { qjs::JS_IsFunction(ctx, f.1) } {
            return Ok(());
        }
        let value = Owned(ctx, get(ctx, data, "value"));
        let spread = Owned(ctx, get(ctx, data, "spread"));
        // The function as the prop holds it now, with the value (and
        // whether the value is its arguments: an `InContext`'s).
        let call = Owned(
            ctx,
            crate::web::js::new_array(
                ctx,
                vec![
                    V::dup(ctx, f.1),
                    V::dup(ctx, value.1),
                    V::dup(ctx, spread.1),
                ],
            )
            .map_err(|_| qjs::JS_EXCEPTION)?
            .take(),
        );
        let slot = format!("{prop}\u{1f}{key}");
        let entry = Owned(ctx, get(ctx, self.renders, &slot));
        // SAFETY: a live value.
        if unsafe { qjs::JS_IsObject(entry.1) } {
            // SAFETY: an entry made below; the signal is its third item.
            let signal = Owned(ctx, unsafe { qjs::JS_GetPropertyUint32(ctx, entry.1, 2) });
            reactive::set_signal(ctx, signal.1, call.take());
            // A throw in the content's effect is the render's error.
            let r = reactive::finish_value(ctx, UNDEFINED);
            // SAFETY: an inline tag check.
            return if unsafe { qjs::JS_IsException(r) } {
                Err(r)
            } else {
                Ok(())
            };
        }
        let signal = Owned(ctx, reactive::new_signal(ctx, call.1));
        let call_of = call_of(ctx)?;
        let (root, made) = reactive::untracked_with(ctx, || {
            reactive::with_root_under(ctx, self.owner, || -> Result<Owned, JsValue> {
                let holder = Owned(ctx, dom::create_element(ctx, nsh_core::Tag::View)?);
                let name = Owned(ctx, new_string(ctx, &slot));
                dom::set_prop_value(ctx, holder.1, "componentRender", name.1)?;
                let content = Owned(
                    ctx,
                    crate::web::js::call(ctx, call_of, UNDEFINED, &[signal.1])
                        .map(|v| v.take())
                        .map_err(|_| qjs::JS_EXCEPTION)?,
                );
                dom::insert_value_at(ctx, holder.1, content.1, None)?;
                Ok(holder)
            })
        });
        let holder = match made {
            Ok(holder) => holder,
            Err(e) => {
                reactive::dispose_owner(ctx, root);
                return Err(e);
            }
        };
        let node = Owned(ctx, dom::node_value(ctx, self.host));
        dom::insert_node(ctx, node.1, holder.1, None)?;
        let entry = crate::web::js::new_array(
            ctx,
            vec![
                V::dup(ctx, holder.1),
                V::num(f64::from(root)),
                V::dup(ctx, signal.1),
            ],
        )
        .map_err(|_| qjs::JS_EXCEPTION)?;
        // SAFETY: the object takes the entry; the atom is freed.
        unsafe {
            let atom = qjs::JS_NewAtomLen(ctx, slot.as_ptr().cast(), slot.len() as _);
            qjs::JS_SetProperty(ctx, self.renders, atom, entry.take());
            qjs::JS_FreeAtom(ctx, atom);
        }
        Ok(())
    }

    /// `{ prop, key }`: what was rendered for (prop, key) goes.
    fn unrender(&self, ctx: *mut JsContext, data: JsValue) -> Result<(), JsValue> {
        let (Some(prop), Some(key)) = (
            string_arg(ctx, Owned(ctx, get(ctx, data, "prop")).1),
            string_arg(ctx, Owned(ctx, get(ctx, data, "key")).1),
        ) else {
            return Ok(());
        };
        let Some((holder, root)) = self.take(ctx, &format!("{prop}\u{1f}{key}")) else {
            return Ok(());
        };
        reactive::dispose_owner(ctx, root);
        let node = Owned(ctx, dom::node_value(ctx, self.host));
        dom::remove_node(ctx, node.1, holder.1)
    }

    /// The holder and root rendered for `slot`, taken out of the table.
    fn take(&self, ctx: *mut JsContext, slot: &str) -> Option<(Owned, u32)> {
        let entry = Owned(ctx, get(ctx, self.renders, slot));
        // SAFETY: a live value.
        if !unsafe { qjs::JS_IsObject(entry.1) } {
            return None;
        }
        // SAFETY: reads of the entry (an array made by `render`); the
        // property goes. Its key is the whole slot, as `get` reads it (a
        // key may hold a NUL).
        unsafe {
            let atom = qjs::JS_NewAtomLen(ctx, slot.as_ptr().cast(), slot.len() as _);
            qjs::JS_DeleteProperty(ctx, self.renders, atom, 0);
            qjs::JS_FreeAtom(ctx, atom);
            let holder = Owned(ctx, qjs::JS_GetPropertyUint32(ctx, entry.1, 0));
            let root = qjs::JS_GetPropertyUint32(ctx, entry.1, 1);
            let mut n = 0f64;
            qjs::JS_ToFloat64(ctx, &mut n, root);
            Some((holder, n as u32))
        }
    }
}

/// The cleanup of a component with event handlers: its host's handled
/// events go.
unsafe extern "C" fn forget_handled(
    ctx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0.0;
    // SAFETY: one data value, the host's id as a number (`render_component`).
    unsafe { qjs::JS_ToFloat64(ctx, &mut id, *data) };
    components(ctx)
        .handled
        .borrow_mut()
        .remove(&(id as nsh_core::NodeId));
    UNDEFINED
}

/// The cleanup of a component with render functions: the roots of what
/// they rendered go (the holders go with the host).
unsafe extern "C" fn dispose_renders(
    ctx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value, the renders' object (`render_component`).
    let renders = unsafe { *data };
    let host = crate::classes::host_outside_calls(ctx);
    let keys = JsIn::new(&host, crate::classes::to_raw(renders))
        .keys()
        .unwrap_or_default();
    let state = Renders {
        props: UNDEFINED,
        renders,
        host: 0,
        owner: 0,
    };
    for key in keys {
        if let Some((_, root)) = state.take(ctx, &key) {
            reactive::dispose_owner(ctx, root);
        }
    }
    UNDEFINED
}
