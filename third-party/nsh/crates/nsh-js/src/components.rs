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
    sync::Arc,
};

use nsh_core::{
    Command, EventKind, Op, Prop,
    element::{
        ComponentSpec, FunctionCall, JsEvent, JsIn, JsResult, ModuleSpec, PropKind, RustCall,
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

/// What the props a component's host takes as a view are called.
const HOST_PROPS: &[&str] = &[
    "class",
    "classList",
    "style",
    "activeStyle",
    "hoverStyle",
    "focusStyle",
    "disabledStyle",
    "testID",
    "focusable",
    "tooltip",
    "onLayout",
];

/// The components' part of a context's state.
#[derive(Default)]
pub(crate) struct Components {
    /// The specs of the components made so far (functions name them by
    /// index).
    specs: RefCell<Vec<Arc<ComponentSpec>>>,
    /// Calls waiting for a result: call number -> (resolve, reject), owned.
    pending: RefCell<FxHashMap<u32, (JsValue, JsValue)>>,
    calls: Cell<u32>,
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
    let k = CString::new(key).unwrap_or_default();
    // SAFETY: a property read of a live value (undefined for non-objects).
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        qjs::JS_GetPropertyStr(cx, obj, k.as_ptr())
    }
}

fn has(cx: *mut JsContext, obj: JsValue, key: &str) -> bool {
    // SAFETY: as `get`.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return false;
        }
        let k = CString::new(key).unwrap_or_default();
        let atom = qjs::JS_NewAtom(cx, k.as_ptr());
        let r = qjs::JS_HasProperty(cx, obj, atom);
        qjs::JS_FreeAtom(cx, atom);
        r == 1
    }
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

/// `ref.measure()`: a promise of where node `id` is after this turn's
/// layout, which the core answers on the root (`Command::Measure`).
pub(crate) fn measure(cx: *mut JsContext, id: u32) -> JsValue {
    let call = next_call(cx);
    if let Err(e) = dom::push_op(
        cx,
        Op::Command {
            id,
            command: Command::Measure { call },
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
        } => {
            let host_js = crate::classes::host_outside_calls(cx);
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
            let data = render_data(cx, prop, &key);
            // SAFETY: the object takes the value.
            unsafe { qjs::JS_SetPropertyStr(cx, data, c"value".as_ptr(), value) };
            component_event(cx, host, RENDER, data)
        }
        JsEvent::Unrender { host, prop, key } => {
            let data = render_data(cx, prop, &key);
            component_event(cx, host, UNRENDER, data)
        }
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
    let mut index = 0f64;
    // SAFETY: one data value, a number (`component`).
    unsafe { qjs::JS_ToFloat64(cx, &mut index, *data) };
    components(cx).specs.borrow()[index as usize].clone()
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
    // SAFETY: two data values (`prop_reader`).
    let (props, key) = unsafe { (*data, *data.add(1)) };
    match string_arg(cx, key) {
        Some(key) => get(cx, props, &key),
        None => qjs::JS_EXCEPTION,
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
    let events = spec
        .events
        .iter()
        .filter(|e| has(cx, props, &handler_name(e.name)))
        .count();
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
    if events != 0 || lazy.is_some() || renders.is_some() {
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
    let spec = spec_of(cx, index);
    let keys = spec
        .props
        .iter()
        .filter(|p| matches!(p.kind, PropKind::Value | PropKind::Renderer))
        .map(|p| (p.name, p.decode))
        .chain(HOST_PROPS.iter().map(|&h| (h, None)));
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
    for (i, (key, decode)) in keys.enumerate() {
        let value = get(cx, props, key);
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
    let event = arg(argc, argv, 0);
    let name = get(cx, event, "name");
    let name_str = string_arg(cx, name);
    if name_str.as_deref() == Some(CHILDREN) {
        // SAFETY: ours; the signal takes the data.
        unsafe { qjs::JS_FreeValue(cx, name) };
        if !unsafe { qjs::JS_IsUndefined(lazy) } {
            reactive::set_signal(cx, lazy, get(cx, event, "data"));
        }
        return UNDEFINED;
    }
    if matches!(name_str.as_deref(), Some(RENDER | UNRENDER)) {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, name) };
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
        let r = if name_str.as_deref() == Some(RENDER) {
            state.render(cx, data.1)
        } else {
            state.unrender(cx, data.1)
        };
        return match r {
            Ok(()) => UNDEFINED,
            Err(e) => e,
        };
    }
    let handler = string_arg(cx, name).map(|n| get(cx, props, &handler_name(&n)));
    // SAFETY: values got are freed; the handler is called with the data.
    unsafe {
        qjs::JS_FreeValue(cx, name);
        let Some(handler) = handler else {
            return qjs::JS_EXCEPTION;
        };
        if !qjs::JS_IsFunction(cx, handler) {
            qjs::JS_FreeValue(cx, handler);
            return UNDEFINED;
        }
        // One argument: the event's data, one object (`api-naming.md`
        // "Payloads").
        let mut args = vec![get(cx, event, "data")];
        let r = qjs::JS_Call(
            cx,
            handler,
            UNDEFINED,
            args.len() as c_int,
            args.as_mut_ptr(),
        );
        for arg in args {
            qjs::JS_FreeValue(cx, arg);
        }
        qjs::JS_FreeValue(cx, handler);
        r
    }
}

// --- Render functions ----------------------------------------------------------------

/// A component's render functions: its props, what they rendered by
/// (prop, key) (`[holder, root]`), its host and the owner it was rendered
/// under (what is rendered sees its context).
struct Renders {
    props: JsValue,
    renders: JsValue,
    host: nsh_core::NodeId,
    owner: u32,
}

impl Renders {
    /// `{ prop, key, value }`: the app's function renders `value` into a
    /// new holder for (prop, key), inserted into the host; the one it
    /// replaces goes.
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
        let slot = format!("{prop}\u{1f}{key}");
        let (root, made) = reactive::untracked_with(ctx, || {
            reactive::with_root_under(ctx, self.owner, || -> Result<Owned, JsValue> {
                let holder = Owned(ctx, dom::create_element(ctx, nsh_core::Tag::View)?);
                let name = Owned(ctx, new_string(ctx, &slot));
                dom::set_prop_value(ctx, holder.1, "componentRender", name.1)?;
                let content = Owned(
                    ctx,
                    crate::web::js::call(ctx, f.1, UNDEFINED, &[value.1])
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
        let old = self.take(ctx, &slot);
        let entry =
            crate::web::js::new_array(ctx, vec![V::dup(ctx, holder.1), V::num(f64::from(root))])
                .map_err(|_| qjs::JS_EXCEPTION)?;
        let key = CString::new(slot).unwrap_or_default();
        // SAFETY: the object takes a dup of the entry.
        unsafe {
            qjs::JS_SetPropertyStr(ctx, self.renders, key.as_ptr(), entry.take());
        }
        match old {
            Some((holder, root)) => {
                reactive::dispose_owner(ctx, root);
                dom::remove_node(ctx, node.1, holder.1)
            }
            None => Ok(()),
        }
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
        let key = CString::new(slot).unwrap_or_default();
        // SAFETY: reads of the entry (an array made by `render`); the
        // property goes.
        unsafe {
            let atom = qjs::JS_NewAtom(ctx, key.as_ptr());
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
