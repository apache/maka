//! What canvas `measureText` returns: `width`, measured at once, and the
//! font's extent above and below the baseline on the line
//! (`fontBoundingBoxAscent` / `fontBoundingBoxDescent`), laid out the first
//! time a script reads one of them. Laying a line out costs more than
//! measuring its width, and most callers (charts, tables) only read `width`.

use super::*;

/// What a `TextMetrics` object holds: what it was measured with, and the
/// extent once a getter laid the line out.
struct Measured {
    font: CanvasFont,
    text: String,
    extent: Cell<Option<(f64, f64)>>,
}

/// The class and prototype of `TextMetrics` (per context).
#[derive(Default)]
pub(super) struct MetricsClass {
    id: Cell<Option<qjs::JSClassID>>,
    /// Owned.
    proto: Cell<Option<JsValue>>,
}

impl MetricsClass {
    /// Frees the prototype (the state is unregistered).
    pub(super) fn free_all(&self, raw: *mut JsContext) {
        if let Some(p) = self.proto.take() {
            // SAFETY: an owned value; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, p) };
        }
    }
}

unsafe extern "C" fn finalize(_rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of this class is a boxed `Measured`.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut Measured;
    if !p.is_null() {
        drop(unsafe { Box::from_raw(p) });
    }
}

/// Registers the class and makes its prototype (once per context).
fn class(cx: *mut JsContext) -> qjs::JSClassID {
    let c = &canvases(cx).metrics;
    if let Some(id) = c.id.get() {
        return id;
    }
    // SAFETY: registering a class; the prototype takes its getters.
    unsafe {
        let rt = qjs::JS_GetRuntime(cx);
        let mut id: qjs::JSClassID = 0;
        qjs::JS_NewClassID(rt, &mut id);
        let def = qjs::JSClassDef {
            class_name: c"TextMetrics".as_ptr(),
            finalizer: Some(finalize),
            gc_mark: None,
            call: None,
            exotic: ptr::null_mut(),
        };
        qjs::JS_NewClass(rt, id, &def);
        let proto = qjs::JS_NewObject(cx);
        for (name, magic) in [
            (c"fontBoundingBoxAscent", 0),
            (c"fontBoundingBoxDescent", 1),
        ] {
            let getter =
                qjs::JS_NewCFunctionData(cx, Some(extent_get), 0, magic, 0, ptr::null_mut());
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            let flags = qjs::JS_PROP_HAS_GET
                | qjs::JS_PROP_HAS_ENUMERABLE
                | qjs::JS_PROP_ENUMERABLE
                | qjs::JS_PROP_HAS_CONFIGURABLE
                | qjs::JS_PROP_CONFIGURABLE;
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

/// A new `TextMetrics` of `text` in `font` whose `width` is `width`.
pub(super) fn new_text_metrics(
    cx: *mut JsContext,
    width: f64,
    font: CanvasFont,
    text: String,
) -> JsValue {
    let id = class(cx);
    // SAFETY: a new object of this class owning its `Measured`.
    unsafe {
        let obj = qjs::JS_NewObjectClass(cx, id);
        if qjs::JS_IsException(obj) {
            return obj;
        }
        let data = Box::into_raw(Box::new(Measured {
            font,
            text,
            extent: Cell::new(None),
        }));
        qjs::JS_SetOpaque(obj, data as *mut c_void);
        qjs::JS_SetPropertyStr(cx, obj, c"width".as_ptr(), new_number(width));
        obj
    }
}

/// `fontBoundingBoxAscent` (magic 0) / `fontBoundingBoxDescent` (1): the
/// line laid out the first time either is read (0 without a line measurer).
unsafe extern "C" fn extent_get(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let id = class(cx);
    // SAFETY: the object owns its `Measured`; the measurer runs no JS.
    let Some(m) = (unsafe { (qjs::JS_GetOpaque(this, id) as *const Measured).as_ref() }) else {
        return UNDEFINED;
    };
    let (ascent, descent) = m.extent.get().unwrap_or_else(|| {
        let shared = dom::shared(cx);
        let extent = shared
            .line_measurer
            .borrow()
            .as_ref()
            .map_or((0.0, 0.0), |measure| {
                let (ascent, descent) = measure(&m.font, &m.text);
                (ascent.0 as f64, descent.0 as f64)
            });
        m.extent.set(Some(extent));
        extent
    });
    new_number(if magic == 0 { ascent } else { descent })
}
