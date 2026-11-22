//! `OffscreenCanvas`: a canvas of a size of its own with no view, drawn with
//! the same 2D context as `<Canvas draw>` (its recording) and rendered into
//! an image by the platform on `convertToBlob` ([`Op::RenderCanvas`],
//! `nsh_core::canvas::render`).

use nsh_core::canvas::render::{ImageFormat, RenderRequest};

use super::*;

/// What an `OffscreenCanvas` object holds.
struct Offscreen {
    width: f64,
    height: f64,
    /// Its 2D context (owned), made by the first `getContext("2d")`.
    context: JsValue,
}

/// The class and prototype of `OffscreenCanvas` (per context).
#[derive(Default)]
pub(super) struct OffscreenClass {
    id: Cell<Option<qjs::JSClassID>>,
    /// Owned.
    proto: Cell<Option<JsValue>>,
}

impl OffscreenClass {
    /// Frees the prototype (the state is unregistered).
    pub(super) fn free_all(&self, raw: *mut JsContext) {
        if let Some(p) = self.proto.take() {
            // SAFETY: an owned value; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, p) };
        }
    }
}

unsafe extern "C" fn finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of this class is a boxed `Offscreen`.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut Offscreen;
    if p.is_null() {
        return;
    }
    let o = unsafe { Box::from_raw(p) };
    // SAFETY: the context it owned.
    unsafe { qjs::JS_FreeValueRT(rt, o.context) };
}

unsafe extern "C" fn mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const Offscreen;
    if let Some(o) = unsafe { p.as_ref() } {
        unsafe { qjs::JS_MarkValue(rt, o.context, mark) };
    }
}

/// Registers the class and makes its prototype (once per context).
fn class(cx: *mut JsContext) -> qjs::JSClassID {
    let c = &canvases(cx).offscreen;
    if let Some(id) = c.id.get() {
        return id;
    }
    // SAFETY: registering a class; the prototype takes its members.
    unsafe {
        let rt = qjs::JS_GetRuntime(cx);
        let mut id: qjs::JSClassID = 0;
        qjs::JS_NewClassID(rt, &mut id);
        let def = qjs::JSClassDef {
            class_name: c"OffscreenCanvas".as_ptr(),
            finalizer: Some(finalize),
            gc_mark: Some(mark),
            call: None,
            exotic: ptr::null_mut(),
        };
        qjs::JS_NewClass(rt, id, &def);
        let proto = qjs::JS_NewObject(cx);
        for (name, f, length) in [
            (c"getContext", get_context as Native, 1),
            (c"convertToBlob", convert_to_blob as Native, 1),
        ] {
            let func = reactive::new_function(cx, name, f, length);
            qjs::JS_SetPropertyStr(cx, proto, name.as_ptr(), func);
        }
        for (name, magic) in [(c"width", 0), (c"height", 1)] {
            let getter = qjs::JS_NewCFunctionData(cx, Some(size_get), 0, magic, 0, ptr::null_mut());
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            let flags =
                qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_CONFIGURABLE | qjs::JS_PROP_CONFIGURABLE;
            qjs::JS_DefineProperty(
                cx,
                proto,
                atom,
                UNDEFINED,
                getter,
                UNDEFINED,
                flags as c_int,
            );
            qjs::JS_FreeAtom(cx, atom);
            qjs::JS_FreeValue(cx, getter);
        }
        qjs::JS_SetClassProto(cx, id, qjs::JS_DupValue(cx, proto));
        c.id.set(Some(id));
        c.proto.set(Some(proto));
        id
    }
}

/// The `Offscreen` of `v` (none for anything else).
fn offscreen<'a>(cx: *mut JsContext, v: JsValue) -> Option<&'a mut Offscreen> {
    let id = class(cx);
    // SAFETY: the object owns its data; callers hold it briefly, running no JS.
    unsafe { (qjs::JS_GetOpaque(v, id) as *mut Offscreen).as_mut() }
}

/// A number argument as WebIDL's `[EnforceRange] unsigned long long`
/// reads it: a finite number, truncated, not negative.
fn dimension(cx: *mut JsContext, v: JsValue, name: &str) -> Result<f64, JsValue> {
    let mut n = f64::NAN;
    // SAFETY: a conversion of a live value (it may run JS: valueOf).
    if unsafe { qjs::JS_ToFloat64(cx, &mut n, v) } < 0 {
        return Err(qjs::JS_EXCEPTION);
    }
    if !n.is_finite() || n < 0.0 {
        let message = CString::new(format!(
            "OffscreenCanvas: {name} must be a finite number not below 0"
        ))
        .unwrap_or_default();
        // SAFETY: throws on a live context; `%s` keeps the message literal.
        return Err(unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) });
    }
    Ok(n.trunc())
}

/// `new OffscreenCanvas(width, height)`: points.
unsafe extern "C" fn constructor(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let width = match dimension(cx, arg(argc, argv, 0), "width") {
        Ok(n) => n,
        Err(e) => return e,
    };
    let height = match dimension(cx, arg(argc, argv, 1), "height") {
        Ok(n) => n,
        Err(e) => return e,
    };
    let id = class(cx);
    // SAFETY: an object of the class owning its data.
    unsafe {
        let obj = qjs::JS_NewObjectClass(cx, id);
        if !qjs::JS_IsException(obj) {
            let data = Box::into_raw(Box::new(Offscreen {
                width,
                height,
                context: UNDEFINED,
            }));
            qjs::JS_SetOpaque(obj, data as *mut c_void);
        }
        obj
    }
}

/// `width` (magic 0) and `height` (magic 1).
unsafe extern "C" fn size_get(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    match offscreen(cx, this) {
        Some(o) => qjs::JS_NewFloat64(if magic == 0 { o.width } else { o.height }),
        None => UNDEFINED,
    }
}

/// `getContext("2d")`: the canvas's 2D context, the same one each time;
/// `null` for other kinds of context.
unsafe extern "C" fn get_context(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let kind = rc_str(cx, arg(argc, argv, 0));
    let Some(o) = offscreen(cx, this) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"Illegal invocation".as_ptr()) };
    };
    if &*kind != "2d" {
        return qjs::JS_NULL;
    }
    // SAFETY: a tag check of an owned value.
    if unsafe { qjs::JS_IsUndefined(o.context) } {
        let context = new_recording(cx, classes(cx).context);
        // SAFETY: a tag check of the new object.
        if unsafe { qjs::JS_IsException(context) } {
            return context;
        }
        let (width, height) = (o.width, o.height);
        // SAFETY: a new object taking two numbers.
        let size = unsafe {
            let size = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(cx, size, c"width".as_ptr(), qjs::JS_NewFloat64(width));
            qjs::JS_SetPropertyStr(cx, size, c"height".as_ptr(), qjs::JS_NewFloat64(height));
            size
        };
        if let Some(r) = recording(cx, context) {
            r.size = size;
            r.reuse = Some(Box::new(Reuse::new(width, height)));
        }
        // `o` again: nothing above ran the app's code.
        if let Some(o) = offscreen(cx, this) {
            o.context = context;
        }
    }
    match offscreen(cx, this) {
        // SAFETY: a dup of the owned context.
        Some(o) => unsafe { qjs::JS_DupValue(cx, o.context) },
        None => UNDEFINED,
    }
}

/// `convertToBlob({ type, scale })`: a promise of the image of what the
/// context drew (PNG; `scale` pixels per point, the screen's by default).
unsafe extern "C" fn convert_to_blob(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: QuickJS's arguments, passed on.
    crate::web::js::rejecting(cx, unsafe { convert(cx, this, argc, argv) })
}

/// [`convert_to_blob`]'s work: its promise, or the exception of what it
/// refuses.
unsafe fn convert(cx: *mut JsContext, this: JsValue, argc: c_int, argv: *mut JsValue) -> JsValue {
    let options = arg(argc, argv, 0);
    let mut mime: Rc<str> = Rc::from("");
    let mut scale = None;
    // SAFETY: reads of the options' properties (they may run JS: getters).
    unsafe {
        if qjs::JS_IsObject(options) {
            let ty = qjs::JS_GetPropertyStr(cx, options, c"type".as_ptr());
            if qjs::JS_IsException(ty) {
                return ty;
            }
            if !qjs::JS_IsUndefined(ty) {
                mime = rc_str(cx, ty);
            }
            qjs::JS_FreeValue(cx, ty);
            let s = qjs::JS_GetPropertyStr(cx, options, c"scale".as_ptr());
            if qjs::JS_IsException(s) {
                return s;
            }
            if !qjs::JS_IsUndefined(s) {
                let mut n = f64::NAN;
                let failed = qjs::JS_ToFloat64(cx, &mut n, s) < 0;
                qjs::JS_FreeValue(cx, s);
                if failed {
                    return qjs::JS_EXCEPTION;
                }
                scale = Some(n as f32);
            } else {
                qjs::JS_FreeValue(cx, s);
            }
        }
    }
    // As HTML: a type it does not encode gives a PNG.
    let format = ImageFormat::from_mime(&mime).unwrap_or_default();
    let Some(o) = offscreen(cx, this) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"Illegal invocation".as_ptr()) };
    };
    let (width, height) = (o.width as f32, o.height as f32);
    let out = recording(cx, o.context)
        .map(|r| Rc::new(r.out.clone()))
        .unwrap_or_default();
    let max = dom::shared(cx).limits.max_canvas_ops;
    if out.len() > max {
        let message = CString::new(format!(
            "an offscreen canvas recorded {} values (limit {max})",
            out.len()
        ))
        .unwrap_or_default();
        // SAFETY: throws on a live context; `%s` keeps the message literal.
        return unsafe { qjs::JS_ThrowRangeError(cx, c"%s".as_ptr(), message.as_ptr()) };
    }
    let len = out.len();
    let drawing = match decode(&RecList(out), 0, len) {
        Ok(d) => d,
        Err(e) => {
            let message = CString::new(format!("nsh canvas: {e}")).unwrap_or_default();
            // SAFETY: as above.
            return unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) };
        }
    };
    let call = crate::components::next_call(cx);
    let promise = crate::components::promise(cx, call);
    // SAFETY: a tag check of the new promise.
    if unsafe { qjs::JS_IsException(promise) } {
        return promise;
    }
    let op = Op::RenderCanvas {
        call,
        request: Box::new({
            let mut request = RenderRequest::default();
            request.drawing = drawing;
            request.size = nsh_core::Size::new(
                nsh_core::geometry::px(width),
                nsh_core::geometry::px(height),
            );
            request.scale = scale;
            request.format = format;
            request
        }),
    };
    match dom::push_op(cx, op) {
        Ok(()) => promise,
        Err(e) => {
            // SAFETY: the promise is not handed out.
            unsafe { qjs::JS_FreeValue(cx, promise) };
            e
        }
    }
}

/// What an offscreen context tracks so that a clear of the whole canvas
/// can drop what it recorded before: an app reusing one `OffscreenCanvas`
/// (an export per item) otherwise records every earlier drawing again in
/// each image, up to `max_canvas_ops`.
///
/// A `clearRect` covering the canvas under the identity transform, with
/// no clip and no `save` open, leaves it transparent, so what was drawn
/// before is invisible: the recording starts anew with only what the
/// context's state still holds (HTML keeps the state across `clearRect`):
/// the last value of each property that took effect and the current path.
/// Whenever that state cannot be written again exactly (a path added
/// under another transform, an animated value), nothing is dropped.
pub(super) struct Reuse {
    /// The canvas's size, points.
    width: f64,
    height: f64,
    /// The transform is the identity (conservatively: no call has changed
    /// it since it last was).
    identity: bool,
    /// A clip is set.
    clipped: bool,
    /// `identity` and `clipped` of each open `save`.
    saved: Vec<(bool, bool)>,
    /// The current path's operations since its `beginPath`.
    path: Vec<Rec>,
    /// Every operation of `path` was added under the identity transform.
    path_exact: bool,
    /// Each property's last operation that took effect (as recorded), by
    /// code.
    properties: Vec<(i32, Vec<Rec>)>,
}

impl Reuse {
    fn new(width: f64, height: f64) -> Reuse {
        Reuse {
            width,
            height,
            identity: true,
            clipped: false,
            saved: Vec::new(),
            path: Vec::new(),
            path_exact: true,
            properties: Vec::new(),
        }
    }
}

/// The numbers of `args`, when they are all `N` numbers.
fn constants<const N: usize>(args: &[Rec]) -> Option<[f64; N]> {
    let mut out = [0.0; N];
    if args.len() != N {
        return None;
    }
    for (o, a) in out.iter_mut().zip(args) {
        match a {
            Rec::Num(n) => *o = *n,
            _ => return None,
        }
    }
    Some(out)
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Whether `rec` reads an animated value.
fn animated(rec: &Rec) -> bool {
    match rec {
        Rec::Node(_) => true,
        Rec::List(items) => items.iter().any(animated),
        _ => false,
    }
}

/// Follows the operation `r` just recorded at `out[start..]` (on offscreen
/// contexts only), and on a clear of the whole canvas starts the recording
/// anew ([`Reuse`]).
pub(super) fn recorded(cx: *mut JsContext, r: &mut Recording, start: usize) {
    let Some(t) = r.reuse.as_deref_mut() else {
        return;
    };
    let Some(Rec::Num(code)) = r.out.get(start) else {
        return;
    };
    let code = *code as i32;
    let args = &r.out[start + 1..];
    match code {
        CV_SAVE => t.saved.push((t.identity, t.clipped)),
        CV_RESTORE => {
            if let Some((identity, clipped)) = t.saved.pop() {
                t.identity = identity;
                t.clipped = clipped;
            }
        }
        CV_TRANSLATE => t.identity &= constants(args) == Some([0.0, 0.0]),
        CV_SCALE => t.identity &= constants(args) == Some([1.0, 1.0]),
        CV_ROTATE => t.identity &= constants(args) == Some([0.0]),
        CV_TRANSFORM => t.identity &= constants(args) == Some(IDENTITY),
        CV_SET_TRANSFORM => t.identity = constants(args) == Some(IDENTITY),
        CV_CLIP => t.clipped = true,
        CV_BEGIN_PATH => {
            t.path.clear();
            t.path_exact = true;
        }
        CV_MOVE_TO..=CV_CLOSE => {
            t.path.extend_from_slice(&r.out[start..]);
            t.path_exact &= t.identity;
        }
        CV_FILL_STYLE..=CV_TEXT_BASELINE | CV_FONT_VARIANT_NUMERIC => {
            // Kept only when it takes effect: the decoder drops a value it
            // cannot read, and the one before stays.
            let op = r.out[start..].to_vec();
            let len = op.len();
            let op = Rc::new(op);
            let effective = decode(&RecList(op.clone()), 0, len).is_ok_and(|d| d.ops.len() == 1);
            if effective {
                let op = Rc::unwrap_or_clone(op);
                match t.properties.iter_mut().find(|(c, _)| *c == code) {
                    Some(slot) => slot.1 = op,
                    None => t.properties.push((code, op)),
                }
            }
        }
        CV_CLEAR_RECT => {
            let Some([x, y, w, h]) = constants(args) else {
                return;
            };
            // HTML ignores a clear of a value that is not finite.
            if ![x, y, w, h].iter().all(|n| n.is_finite()) {
                return;
            }
            let covers = x.min(x + w) <= 0.0
                && y.min(y + h) <= 0.0
                && x.max(x + w) >= t.width
                && y.max(y + h) >= t.height;
            if !covers || !t.identity || t.clipped || !t.saved.is_empty() {
                return;
            }
            if !t.path.is_empty() && !t.path_exact {
                return;
            }
            let kept = t.properties.iter().flat_map(|(_, op)| op).chain(&t.path);
            if kept.clone().any(animated) {
                return;
            }
            let out: Vec<Rec> = kept.cloned().collect();
            r.out = out;
            free_values(cx, std::mem::take(&mut r.used));
        }
        _ => {}
    }
}

/// `nsh`'s `OffscreenCanvas` constructor.
pub(super) fn constructor_function(cx: *mut JsContext) -> JsValue {
    class(cx);
    let proto = canvases(cx).offscreen.proto.get();
    // SAFETY: a constructor-or-function whose `prototype` is the class's.
    unsafe {
        let func = qjs::JS_NewCFunction2(
            cx,
            Some(constructor),
            c"OffscreenCanvas".as_ptr(),
            2,
            qjs::JSCFunctionEnum_JS_CFUNC_constructor_or_func,
            0,
        );
        if let Some(proto) = proto {
            qjs::JS_SetConstructor(cx, func, proto);
        }
        func
    }
}
