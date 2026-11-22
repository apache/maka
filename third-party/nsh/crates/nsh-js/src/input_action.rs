//! Input callbacks with their arguments captured as immutable JSON.
//!
//! The callable owns its handler and captured arguments.

use std::{
    ffi::{c_int, c_void},
    ptr,
};

use rquickjs::{Ctx, Exception, Type, Value, qjs};

use crate::{reactive, state::state};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const JSON_BYTES: usize = 8 * 1024 * 1024;
const JSON_DEPTH: usize = 64;

/// The per-VM class; action values themselves own all callback data.
pub(crate) struct Actions {
    class: qjs::JSClassID,
}

impl Actions {
    pub(crate) fn new(ctx: *mut JsContext) -> Self {
        // SAFETY: registering a class on the context's runtime.
        unsafe {
            let rt = qjs::JS_GetRuntime(ctx);
            let mut class = 0;
            qjs::JS_NewClassID(rt, &mut class);
            let def = qjs::JSClassDef {
                class_name: c"InputAction".as_ptr(),
                finalizer: Some(finalize),
                gc_mark: Some(mark),
                call: Some(call),
                exotic: ptr::null_mut(),
            };
            if qjs::JS_NewClass(rt, class, &def) < 0 {
                return Self { class: 0 };
            }
            qjs::JS_SetClassProto(ctx, class, qjs::JS_GetFunctionProto(ctx));
            Self { class }
        }
    }
}

struct Data {
    handler: JsValue,
    args: JsValue,
}

fn data(ctx: *mut JsContext, value: JsValue) -> *const Data {
    // SAFETY: the context state owns this class; only its instances have
    // an opaque pointer to Data. No JavaScript runs while reading it.
    unsafe {
        let class = (*state(ctx)).actions.class;
        if class == 0 {
            ptr::null()
        } else {
            qjs::JS_GetOpaque(value, class) as *const Data
        }
    }
}

/// Whether `value` is an input action made by this VM.
fn is_action(ctx: *mut JsContext, value: JsValue) -> bool {
    !data(ctx, value).is_null()
}

unsafe extern "C" fn finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: an action's opaque pointer is its owned boxed data, and
    // this finalizer is registered only for its class.
    unsafe {
        let p = qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) as *mut Data;
        if !p.is_null() {
            let data = Box::from_raw(p);
            qjs::JS_FreeValueRT(rt, data.handler);
            qjs::JS_FreeValueRT(rt, data.args);
        }
    }
}

unsafe extern "C" fn mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: the same class-owned data as in the finalizer; marking
    // reads it without calling JavaScript.
    unsafe {
        let p = qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) as *const Data;
        if !p.is_null() {
            qjs::JS_MarkValue(rt, (*p).handler, mark);
            qjs::JS_MarkValue(rt, (*p).args, mark);
        }
    }
}

unsafe extern "C" fn call(
    ctx: *mut JsContext,
    func: JsValue,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _flags: c_int,
) -> JsValue {
    // SAFETY: QuickJS calls this only for a live action. Dups keep its
    // values alive without borrowing native data across application JS.
    unsafe {
        let (handler, args) = {
            let data = &*data(ctx, func);
            (
                qjs::JS_DupValue(ctx, data.handler),
                qjs::JS_DupValue(ctx, data.args),
            )
        };
        let mut argv = [args];
        let result = qjs::JS_Call(ctx, handler, qjs::JS_UNDEFINED, 1, argv.as_mut_ptr());
        qjs::JS_FreeValue(ctx, handler);
        qjs::JS_FreeValue(ctx, args);
        result
    }
}

/// `inputAction(handler, args)`: a callback using only captured args.
pub(crate) unsafe extern "C" fn input_action(
    ctx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let handler = reactive::arg(argc, argv, 0);
    let args = reactive::arg(argc, argv, 1);
    // SAFETY: arguments belong to the current native call.
    unsafe {
        if (*state(ctx)).actions.class == 0 {
            return qjs::JS_ThrowInternalError(ctx, c"inputAction: class unavailable".as_ptr());
        }
        if !qjs::JS_IsFunction(ctx, handler) || is_action(ctx, handler) {
            return qjs::JS_ThrowTypeError(
                ctx,
                c"inputAction: handler must be a function other than an input action".as_ptr(),
            );
        }
        if argc < 2
            || qjs::JS_IsUndefined(args)
            || qjs::JS_IsFunction(ctx, args)
            || qjs::JS_IsSymbol(args)
            || qjs::JS_IsBigInt(args)
        {
            return qjs::JS_ThrowTypeError(
                ctx,
                c"inputAction: args must be a defined JSON value".as_ptr(),
            );
        }
    }
    let args = match capture(ctx, args) {
        Ok(captured) => captured,
        Err(error) => return error,
    };
    // SAFETY: the new class instance takes the snapshot and a reference
    // to the handler; its finalizer releases both.
    unsafe {
        let obj = qjs::JS_NewObjectClass(ctx, (*state(ctx)).actions.class);
        if qjs::JS_IsException(obj) {
            qjs::JS_FreeValue(ctx, args);
            return obj;
        }
        let data = Box::new(Data {
            handler: qjs::JS_DupValue(ctx, handler),
            args,
        });
        qjs::JS_SetOpaque(obj, Box::into_raw(data) as *mut c_void);
        obj
    }
}

fn capture(ctx: *mut JsContext, args: JsValue) -> Result<JsValue, JsValue> {
    // SAFETY: a context reference for the decoder; its value owns a dup
    // of the argument. Only capture may read application properties.
    let cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(ctx)) };
    let args = unsafe { Value::from_raw(cx.clone(), qjs::JS_DupValue(ctx, args)) };
    let mut json = capture_json(&args, 0, &mut Budget::default()).map_err(|error| {
        if !matches!(error, rquickjs::Error::Exception) {
            Exception::throw_type(&cx, &format!("inputAction: {error}"));
        }
        qjs::JS_EXCEPTION
    })?;
    // Capture object keys in a stable order.
    json.sort_all_objects();
    match serde_json::to_string(&json) {
        Ok(value) if value.len() <= JSON_BYTES => {}
        _ => {
            Exception::throw_range(&cx, "inputAction: captured JSON exceeds 8 MiB");
            return Err(qjs::JS_EXCEPTION);
        }
    };
    let frozen = frozen_json(ctx, &json);
    // SAFETY: inspecting the result of native construction.
    if unsafe { qjs::JS_IsException(frozen) } {
        Err(frozen)
    } else {
        Ok(frozen)
    }
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: usize,
}

impl Budget {
    fn bytes(&mut self, ctx: &Ctx<'_>, count: usize) -> rquickjs::Result<()> {
        if count > JSON_BYTES - self.bytes {
            return Err(Exception::throw_range(
                ctx,
                "inputAction: captured JSON exceeds 8 MiB",
            ));
        }
        self.bytes += count;
        Ok(())
    }

    fn entries(&mut self, ctx: &Ctx<'_>, count: usize) -> rquickjs::Result<()> {
        if count > crate::protocol::JSON_ENTRIES - self.entries {
            return Err(Exception::throw_range(
                ctx,
                "inputAction: captured JSON exceeds 1048576 entries",
            ));
        }
        self.entries += count;
        Ok(())
    }

    fn string(&mut self, value: rquickjs::String<'_>) -> rquickjs::Result<String> {
        let ctx = value.ctx().clone();
        let encoded = value.to_cstring()?;
        self.bytes(&ctx, encoded.len().saturating_add(2))?;
        // SAFETY: the owned CString keeps exactly these bytes alive.
        // QuickJS preserves unmatched surrogates, so validate UTF-8
        // before creating a Rust string, as the ordinary decoder does.
        let bytes =
            unsafe { std::slice::from_raw_parts(encoded.as_ptr().cast::<u8>(), encoded.len()) };
        let text = std::str::from_utf8(bytes)?;
        let escapes = text
            .bytes()
            .map(|byte| match byte {
                b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r' => 1,
                0..=0x1f => 5,
                _ => 0,
            })
            .sum();
        self.bytes(&ctx, escapes)?;
        Ok(text.to_owned())
    }
}

/// The native JSON normalization with allocation checked before copying
/// strings or reserving arrays. The ordinary protocol path is unchanged.
fn capture_json(
    value: &Value<'_>,
    depth: usize,
    budget: &mut Budget,
) -> rquickjs::Result<nsh_core::JsonValue> {
    use nsh_core::JsonValue as J;
    let ctx = value.ctx();
    if depth > JSON_DEPTH {
        return Err(Exception::throw_range(
            ctx,
            "inputAction: captured JSON exceeds 64 levels",
        ));
    }
    let scalar = match value.type_of() {
        Type::Bool => J::Bool(value.as_bool().unwrap_or(false)),
        Type::Int => J::from(value.as_int().unwrap_or(0)),
        Type::Float => {
            let number = value.as_float().unwrap_or(0.0);
            if number.fract() == 0.0 && number.abs() < 9.0e15 {
                J::from(number as i64)
            } else {
                serde_json::Number::from_f64(number).map_or(J::Null, J::Number)
            }
        }
        Type::String => {
            return Ok(J::String(
                budget.string(value.as_string().expect("string").clone())?,
            ));
        }
        Type::Array => {
            let array = value.as_array().expect("array");
            let mut len = 0;
            // SAFETY: a live array; the checked API accepts lengths
            // beyond Int32, unlike the wrapper's asserting len().
            if unsafe { qjs::JS_GetLength(ctx.as_raw().as_ptr(), value.as_raw(), &mut len) } < 0 {
                return Err(rquickjs::Error::Exception);
            }
            let len = usize::try_from(len).map_err(|_| {
                Exception::throw_range(ctx, "inputAction: captured JSON exceeds 1048576 entries")
            })?;
            budget.entries(ctx, len)?;
            budget.bytes(ctx, 2 + len.saturating_sub(1))?;
            let mut items = Vec::with_capacity(len);
            for index in 0..len {
                items.push(capture_json(
                    &array.get::<Value>(index)?,
                    depth + 1,
                    budget,
                )?);
            }
            return Ok(J::Array(items));
        }
        Type::Object => {
            let object = value.as_object().expect("object");
            let entries = object.props::<rquickjs::String, Value>();
            budget.entries(ctx, entries.len())?;
            budget.bytes(ctx, 2)?;
            let mut fields = serde_json::Map::new();
            for entry in entries {
                let (key, item) = entry?;
                if matches!(
                    item.type_of(),
                    Type::Undefined | Type::Function | Type::Symbol
                ) {
                    continue;
                }
                budget.bytes(ctx, 1 + usize::from(!fields.is_empty()))?;
                let key = budget.string(key)?;
                fields.insert(key, capture_json(&item, depth + 1, budget)?);
            }
            return Ok(J::Object(fields));
        }
        _ => J::Null,
    };
    budget.bytes(ctx, scalar.to_string().len())?;
    Ok(scalar)
}

/// Builds fresh data properties, bypassing application setters and
/// preserving all JSON object keys, including `__proto__` and NULs.
fn frozen_json(ctx: *mut JsContext, json: &nsh_core::JsonValue) -> JsValue {
    use nsh_core::JsonValue as J;
    // SAFETY: all objects and values here are newly created on this
    // context. DefineProperty consumes children, and every failed path
    // frees the partially built container. Freezing fresh plain data
    // cannot invoke JavaScript.
    unsafe {
        let object = match json {
            J::Null => return qjs::JS_NULL,
            J::Bool(value) => return if *value { qjs::JS_TRUE } else { qjs::JS_FALSE },
            J::Number(value) => return qjs::JS_NewFloat64(value.as_f64().unwrap_or(0.0)),
            J::String(value) => {
                return qjs::JS_NewStringLen(ctx, value.as_ptr().cast(), value.len() as _);
            }
            J::Array(items) => {
                let object = qjs::JS_NewArray(ctx);
                if qjs::JS_IsException(object) {
                    return object;
                }
                for (index, item) in items.iter().enumerate() {
                    let value = frozen_json(ctx, item);
                    if qjs::JS_IsException(value)
                        || qjs::JS_DefinePropertyValueUint32(
                            ctx,
                            object,
                            index as u32,
                            value,
                            qjs::JS_PROP_C_W_E as _,
                        ) < 0
                    {
                        qjs::JS_FreeValue(ctx, object);
                        return qjs::JS_EXCEPTION;
                    }
                }
                object
            }
            J::Object(fields) => {
                let object = qjs::JS_NewObject(ctx);
                if qjs::JS_IsException(object) {
                    return object;
                }
                for (key, item) in fields {
                    let value = frozen_json(ctx, item);
                    if qjs::JS_IsException(value) {
                        qjs::JS_FreeValue(ctx, object);
                        return value;
                    }
                    let atom = qjs::JS_NewAtomLen(ctx, key.as_ptr().cast(), key.len() as _);
                    if atom == 0 {
                        qjs::JS_FreeValue(ctx, value);
                        qjs::JS_FreeValue(ctx, object);
                        return qjs::JS_EXCEPTION;
                    }
                    let result = qjs::JS_DefinePropertyValue(
                        ctx,
                        object,
                        atom,
                        value,
                        qjs::JS_PROP_C_W_E as _,
                    );
                    qjs::JS_FreeAtom(ctx, atom);
                    if result < 0 {
                        qjs::JS_FreeValue(ctx, object);
                        return qjs::JS_EXCEPTION;
                    }
                }
                object
            }
        };
        if qjs::JS_FreezeObject(ctx, object) < 0 {
            qjs::JS_FreeValue(ctx, object);
            qjs::JS_EXCEPTION
        } else {
            object
        }
    }
}
