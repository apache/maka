//! `nsh/canvas`: `Canvas` (a view drawn with an HTML Canvas 2D context,
//! replayed natively), `Path2D` and the classes of the context and
//! gradients.
//!
//! A drawing makes thousands of calls, so the context's methods are raw
//! natives that record into a Rust list ([`Rec`]) instead of a JS array;
//! the core's decoder reads that list (`nsh_core::js::canvas::decode`).
//! The methods and properties that only record are made from the
//! core's specs (`CanvasOp`'s and `PathOp`'s `#[derive(JsOps)]`); the
//! rest (paints, the state stack, paths, text, images) is here.
//!
//! Paths and gradients are taken as they are when a drawing uses them
//! (`fill(path)`, `fillStyle = gradient`), as a browser draws at once.

use std::{
    cell::Cell,
    ffi::{CStr, CString, c_int, c_void},
    ptr,
    rc::Rc,
    sync::OnceLock,
};

use nsh_core::{
    EventKind, FontVariant, Op, Tag,
    canvas::{CanvasFont, CanvasOp, FillRule, PathOp, point_in_path, point_in_stroke},
    element::TsTypes,
    js::{
        canvas::*,
        host::{HostInput, HostList},
        ops::{JsOps, OpMethod, OpProperty},
    },
};
use rquickjs::qjs;

use crate::{
    dom,
    modules::{Export, Item, Ts},
    reactive::{self, Native, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// A recorded value, as the core's decoder reads it.
#[derive(Clone, Debug)]
pub(crate) enum Rec {
    Null,
    Bool(bool),
    Num(f64),
    Str(Rc<str>),
    List(Rc<Vec<Rec>>),
    /// A native animation node (`AnimatedNode.__av`).
    Node(nsh_core::animation::NodeId),
}

/// A recorded list, read by index.
pub(crate) struct RecList(Rc<Vec<Rec>>);

impl HostList for RecList {
    type Item = Rec;

    fn len(&self) -> usize {
        self.0.len()
    }

    fn item(&self, index: usize) -> Option<Rec> {
        self.0.get(index).cloned()
    }
}

impl HostInput for Rec {
    type List = RecList;

    fn is_nullish(&self) -> bool {
        matches!(self, Rec::Null)
    }

    fn is_object(&self) -> bool {
        matches!(self, Rec::List(_) | Rec::Node(_))
    }

    fn as_bool(&self) -> Option<bool> {
        match self {
            Rec::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn as_number(&self) -> Option<f64> {
        match self {
            Rec::Num(n) => Some(*n),
            _ => None,
        }
    }

    fn as_string(&self) -> Option<String> {
        match self {
            Rec::Str(s) => Some(s.to_string()),
            _ => None,
        }
    }

    fn field(&self, key: &str) -> Option<Self> {
        match self {
            Rec::Node(id) if key == "__av" => Some(Rec::Num(*id as f64)),
            _ => None,
        }
    }

    fn as_list(&self) -> Option<RecList> {
        match self {
            Rec::List(l) => Some(RecList(l.clone())),
            _ => None,
        }
    }

    fn entries(&self) -> Vec<(String, Self)> {
        Vec::new()
    }

    fn truthy(&self) -> bool {
        match self {
            Rec::Null => false,
            Rec::Bool(b) => *b,
            Rec::Num(n) => *n != 0.0 && !n.is_nan(),
            Rec::Str(s) => !s.is_empty(),
            Rec::List(_) | Rec::Node(_) => true,
        }
    }

    fn animated_node(&self) -> Option<nsh_core::animation::NodeId> {
        match self {
            Rec::Node(id) => Some(*id),
            _ => None,
        }
    }
}

/// The recording methods and properties, made from the core's specs once.
struct Specs {
    /// Path methods (contexts have them too).
    path: Vec<OpMethod>,
    /// The context's own methods.
    context: Vec<OpMethod>,
    properties: Vec<OpProperty>,
}

fn specs() -> &'static Specs {
    static SPECS: OnceLock<Specs> = OnceLock::new();
    SPECS.get_or_init(|| {
        let mut types = TsTypes::default();
        let (mut path, mut context, mut properties) = (Vec::new(), Vec::new(), Vec::new());
        PathOp::methods(&mut types, &mut path);
        CanvasOp::methods(&mut types, &mut context);
        CanvasOp::properties(&mut types, &mut properties);
        Specs {
            path,
            context,
            properties,
        }
    })
}

/// A JS literal of the specs (a default or an initial value) as a record.
fn literal(text: &str) -> Rec {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Number(n)) => Rec::Num(n.as_f64().unwrap_or(0.0)),
        Ok(serde_json::Value::String(s)) => Rec::Str(s.into()),
        Ok(serde_json::Value::Bool(b)) => Rec::Bool(b),
        _ => Rec::Null,
    }
}

/// The classes and prototypes of `nsh/canvas` (per context).
pub(crate) struct Canvases {
    classes: Cell<Option<Classes>>,
    /// Prototypes (owned): context, path, gradient.
    protos: Cell<[JsValue; 3]>,
}

impl Default for Canvases {
    fn default() -> Canvases {
        Canvases {
            classes: Cell::new(None),
            protos: Cell::new([UNDEFINED; 3]),
        }
    }
}

impl Canvases {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        for p in self.protos.replace([UNDEFINED; 3]) {
            // SAFETY: owned values; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, p) };
        }
    }
}

#[derive(Clone, Copy)]
struct Classes {
    context: qjs::JSClassID,
    path: qjs::JSClassID,
    gradient: qjs::JSClassID,
}

const CONTEXT: usize = 0;
const PATH: usize = 1;
const GRADIENT: usize = 2;

fn canvases<'a>(cx: *mut JsContext) -> &'a Canvases {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).canvases }
}

/// What a context, a path or a gradient holds.
struct Recording {
    out: Vec<Rec>,
    /// Animated values the recording uses (owned): kept with the view.
    used: Vec<JsValue>,
    /// Contexts: the drawing state (the properties' values, owned, for the
    /// getters) and the saved states.
    state: DrawState,
    stack: Vec<DrawState>,
    /// Contexts: the size given to `draw` (owned).
    size: JsValue,
    /// Contexts: `draw` returned; later calls (from a timer) are ignored.
    closed: bool,
    /// Closed contexts: what `draw` recorded, for hit tests afterwards
    /// (`isPointInPath` in a press handler).
    drawn: Option<Rc<Vec<Rec>>>,
}

/// The drawing state: the properties set, by name (owned values).
#[derive(Default)]
struct DrawState(Vec<(&'static str, JsValue)>);

impl DrawState {
    fn get(&self, key: &str) -> Option<JsValue> {
        self.0.iter().find(|(k, _)| *k == key).map(|&(_, v)| v)
    }
}

impl Recording {
    /// Every JS value it owns.
    fn values(&self) -> impl Iterator<Item = JsValue> + '_ {
        let states = std::iter::once(&self.state).chain(&self.stack);
        states
            .flat_map(|s| s.0.iter().map(|&(_, v)| v))
            .chain(self.used.iter().copied())
            .chain([self.size])
    }
}

/// The opaque of a canvas class's object.
///
/// # Safety
///
/// `obj` is an object of a canvas class.
unsafe fn opaque(obj: JsValue) -> *mut Recording {
    // SAFETY: per the contract.
    unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) as *mut Recording }
}

unsafe extern "C" fn recording_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of these classes is a boxed recording.
    let p = unsafe { opaque(obj) };
    if p.is_null() {
        return;
    }
    let r = unsafe { Box::from_raw(p) };
    for v in r.values() {
        // SAFETY: values the recording owned.
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
}

unsafe extern "C" fn recording_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { opaque(obj) };
    if let Some(r) = unsafe { p.as_ref() } {
        for v in r.values() {
            unsafe { qjs::JS_MarkValue(rt, v, mark) };
        }
    }
}

/// The recording of a context, path or gradient `v` (null for anything
/// else).
fn recording_ptr(cx: *mut JsContext, v: JsValue) -> *mut Recording {
    let c = classes(cx);
    // SAFETY: reading the class and opaque of a live value.
    unsafe {
        let class = qjs::JS_GetClassID(v);
        if class != c.context && class != c.path && class != c.gradient {
            return ptr::null_mut();
        }
        qjs::JS_GetOpaque(v, class) as *mut Recording
    }
}

/// [`recording_ptr`] as a reference, for code that neither runs JS nor
/// reads another recording while it holds it.
fn recording<'a>(cx: *mut JsContext, v: JsValue) -> Option<&'a mut Recording> {
    // SAFETY: the object owns its recording; callers hold it briefly.
    unsafe { recording_ptr(cx, v).as_mut() }
}

/// The context's hand-written properties (their magic follows the specs').
const OWN_PROPERTIES: [&str; 4] = ["fillStyle", "strokeStyle", "shadowOffsetX", "shadowOffsetY"];

/// Registers the classes and makes the prototypes (once per context).
fn classes(cx: *mut JsContext) -> Classes {
    let cv = canvases(cx);
    if let Some(c) = cv.classes.get() {
        return c;
    }
    let s = specs();
    // SAFETY: registering classes; the prototypes take their members.
    unsafe {
        let rt = qjs::JS_GetRuntime(cx);
        let class = |name: &'static CStr| {
            let mut id: qjs::JSClassID = 0;
            qjs::JS_NewClassID(rt, &mut id);
            let def = qjs::JSClassDef {
                class_name: name.as_ptr(),
                finalizer: Some(recording_finalize),
                gc_mark: Some(recording_mark),
                call: None,
                exotic: ptr::null_mut(),
            };
            qjs::JS_NewClass(rt, id, &def);
            id
        };
        let classes = Classes {
            context: class(c"CanvasRenderingContext2D"),
            path: class(c"Path2D"),
            gradient: class(c"CanvasGradient"),
        };
        // Set before the members: they look the classes up.
        cv.classes.set(Some(classes));
        let set = |obj: JsValue, name: &str, f: JsValue| {
            let k = CString::new(name).unwrap_or_default();
            qjs::JS_SetPropertyStr(cx, obj, k.as_ptr(), f);
        };
        let recorders = |obj: JsValue, list: &[OpMethod], magic_base: usize| {
            for (i, m) in list.iter().enumerate() {
                let f = qjs::JS_NewCFunctionData(
                    cx,
                    Some(record_method),
                    m.params.len() as c_int,
                    (magic_base + i) as c_int,
                    0,
                    ptr::null_mut(),
                );
                set(obj, m.name, f);
            }
        };
        let natives = |obj: JsValue, list: &[(&CStr, Native, c_int)]| {
            for &(name, f, length) in list {
                let func = reactive::new_function(cx, name, f, length);
                qjs::JS_SetPropertyStr(cx, obj, name.as_ptr(), func);
            }
        };
        let path_proto = qjs::JS_NewObject(cx);
        recorders(path_proto, &s.path, 0);
        natives(
            path_proto,
            &[(c"roundRect", round_rect, 5), (c"addPath", add_path, 1)],
        );
        let context_proto = qjs::JS_NewObject(cx);
        recorders(context_proto, &s.path, 0);
        recorders(context_proto, &s.context, s.path.len());
        natives(
            context_proto,
            &[
                (c"roundRect", round_rect, 5),
                (c"save", save, 0),
                (c"restore", restore, 0),
                (c"resetTransform", reset_transform, 0),
                (c"setLineDash", set_line_dash, 1),
                (c"getLineDash", get_line_dash, 0),
                (c"fill", fill, 2),
                (c"stroke", stroke, 1),
                (c"clip", clip, 2),
                (c"fillText", fill_text, 4),
                (c"strokeText", stroke_text, 4),
                (c"measureText", measure_text, 1),
                (c"isPointInPath", is_point_in_path, 4),
                (c"isPointInStroke", is_point_in_stroke, 3),
                (c"createLinearGradient", linear_gradient, 4),
                (c"createRadialGradient", radial_gradient, 6),
                (c"createConicGradient", conic_gradient, 3),
                (c"drawImage", draw_image, 9),
            ],
        );
        let accessor = |name: &str, getter: JsValue, setter: JsValue| {
            let k = CString::new(name).unwrap_or_default();
            let atom = qjs::JS_NewAtom(cx, k.as_ptr());
            let flags = qjs::JS_PROP_HAS_GET
                | qjs::JS_PROP_HAS_SET
                | qjs::JS_PROP_HAS_CONFIGURABLE
                | qjs::JS_PROP_CONFIGURABLE;
            qjs::JS_DefineProperty(
                cx,
                context_proto,
                atom,
                UNDEFINED,
                getter,
                setter,
                flags as c_int,
            );
            qjs::JS_FreeAtom(cx, atom);
            qjs::JS_FreeValue(cx, getter);
            qjs::JS_FreeValue(cx, setter);
        };
        let names = s.properties.iter().map(|p| p.name).chain(OWN_PROPERTIES);
        for (i, name) in names.enumerate() {
            let magic = |f, length| {
                qjs::JS_NewCFunctionData(cx, Some(f), length, i as c_int, 0, ptr::null_mut())
            };
            accessor(name, magic(property_get, 0), magic(property_set, 1));
        }
        let size = reactive::new_function(cx, c"canvas", context_size, 0);
        accessor("canvas", size, UNDEFINED);
        let gradient_proto = qjs::JS_NewObject(cx);
        natives(gradient_proto, &[(c"addColorStop", add_color_stop, 2)]);
        let protos = [context_proto, path_proto, gradient_proto];
        let ids = [classes.context, classes.path, classes.gradient];
        for (id, proto) in ids.into_iter().zip(protos) {
            qjs::JS_SetClassProto(cx, id, qjs::JS_DupValue(cx, proto));
        }
        cv.protos.set(protos);
        classes
    }
}

/// A new object of `class` with an empty recording (owned).
fn new_recording(cx: *mut JsContext, class: qjs::JSClassID) -> JsValue {
    // SAFETY: an object of a canvas class owning its recording.
    unsafe {
        let obj = qjs::JS_NewObjectClass(cx, class);
        if !qjs::JS_IsException(obj) {
            let data = Box::into_raw(Box::new(Recording {
                out: Vec::new(),
                used: Vec::new(),
                state: DrawState::default(),
                stack: Vec::new(),
                size: UNDEFINED,
                closed: false,
                drawn: None,
            }));
            qjs::JS_SetOpaque(obj, data as *mut c_void);
        }
        obj
    }
}

/// A string value's text, shared.
fn rc_str(cx: *mut JsContext, v: JsValue) -> Rc<str> {
    // SAFETY: a live value; the C string is freed below.
    unsafe {
        let mut len = 0usize;
        let p = qjs::JS_ToCStringLen(cx, &mut len, v);
        if p.is_null() {
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            return Rc::from("");
        }
        let bytes = std::slice::from_raw_parts(p.cast::<u8>(), len);
        let s: Rc<str> = match std::str::from_utf8(bytes) {
            Ok(s) => Rc::from(s),
            Err(_) => Rc::from(String::from_utf8_lossy(bytes).as_ref()),
        };
        qjs::JS_FreeCString(cx, p);
        s
    }
}

/// A JS value as a record (borrowed); the animated values it holds are added
/// to `used` (owned dups).
fn to_rec(cx: *mut JsContext, v: JsValue, used: &mut Vec<JsValue>, depth: u32) -> Rec {
    // SAFETY: inline checks and reads of a live value; values got are freed.
    unsafe {
        let tag = qjs::JS_VALUE_GET_TAG(v);
        if tag == qjs::JS_TAG_INT {
            return Rec::Num(qjs::JS_VALUE_GET_INT(v) as f64);
        }
        if qjs::JS_TAG_IS_FLOAT64(tag) {
            return Rec::Num(qjs::JS_VALUE_GET_FLOAT64(v));
        }
        if tag == qjs::JS_TAG_STRING {
            return Rec::Str(rc_str(cx, v));
        }
        if tag == qjs::JS_TAG_BOOL {
            return Rec::Bool(qjs::JS_VALUE_GET_BOOL(v));
        }
        if !qjs::JS_IsObject(v) || depth > 8 {
            return Rec::Null;
        }
        // A path's or a gradient's recording, as it is now.
        if let Some(r) = recording_ptr(cx, v).as_ref() {
            used.extend(r.used.iter().map(|&u| qjs::JS_DupValue(cx, u)));
            return Rec::List(Rc::new(r.out.clone()));
        }
        let nv = qjs::JS_GetPropertyStr(cx, v, c"__av".as_ptr());
        if qjs::JS_IsNumber(nv) {
            let mut n = 0f64;
            qjs::JS_ToFloat64(cx, &mut n, nv);
            used.push(qjs::JS_DupValue(cx, v));
            return Rec::Node(n as nsh_core::animation::NodeId);
        }
        qjs::JS_FreeValue(cx, nv);
        if qjs::JS_IsArray(v) {
            let mut len: i64 = 0;
            qjs::JS_GetLength(cx, v, &mut len);
            let mut items = Vec::with_capacity(len.clamp(0, 1 << 16) as usize);
            for i in 0..len.max(0) {
                let item = qjs::JS_GetPropertyInt64(cx, v, i);
                items.push(to_rec(cx, item, used, depth + 1));
                qjs::JS_FreeValue(cx, item);
            }
            return Rec::List(Rc::new(items));
        }
        // Other objects read as nothing (the decoder's default).
        Rec::Null
    }
}

fn throw_not_recording(cx: *mut JsContext) -> JsValue {
    // SAFETY: throws on a live context.
    unsafe { qjs::JS_ThrowTypeError(cx, c"not a canvas context or path".as_ptr()) }
}

/// Records `code` and `args` (borrowed) on `this`'s recording.
fn record(cx: *mut JsContext, this: JsValue, code: i32, args: &[JsValue]) -> JsValue {
    let p = recording_ptr(cx, this);
    // SAFETY: the recording `this` owns; each `&mut` is made only while no
    // other recording is read (`to_rec` reads one, possibly this one).
    unsafe {
        let Some(r) = p.as_mut() else {
            return throw_not_recording(cx);
        };
        if r.closed {
            return UNDEFINED;
        }
        r.out.push(Rec::Num(code as f64));
        let mut used = Vec::new();
        for &a in args {
            let rec = to_rec(cx, a, &mut used, 0);
            (*p).out.push(rec);
        }
        (*p).used.append(&mut used);
    }
    UNDEFINED
}

fn free_values(cx: *mut JsContext, values: impl IntoIterator<Item = JsValue>) {
    for v in values {
        // SAFETY: owned values.
        unsafe { qjs::JS_FreeValue(cx, v) };
    }
}

fn new_number(n: f64) -> JsValue {
    qjs::JS_NewFloat64(n)
}

fn new_string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

fn is_undefined(v: JsValue) -> bool {
    // SAFETY: an inline tag check.
    unsafe { qjs::JS_IsUndefined(v) }
}

/// A recording method of the specs (magic: the path methods', then the
/// context's).
unsafe extern "C" fn record_method(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let s = specs();
    let magic = magic as usize;
    let m = match s.path.get(magic) {
        Some(m) => m,
        None => &s.context[magic - s.path.len()],
    };
    let p = recording_ptr(cx, this);
    // SAFETY: as in `record`.
    unsafe {
        let Some(r) = p.as_mut() else {
            return throw_not_recording(cx);
        };
        if r.closed {
            return UNDEFINED;
        }
        r.out.reserve(m.params.len() + 1);
        r.out.push(Rec::Num(m.code as f64));
        let mut used = Vec::new();
        for (i, param) in m.params.iter().enumerate() {
            let a = arg(argc, argv, i);
            let rec = match param.default {
                Some(default) if is_undefined(a) => literal(default),
                _ => to_rec(cx, a, &mut used, 0),
            };
            (*p).out.push(rec);
        }
        (*p).used.append(&mut used);
    }
    UNDEFINED
}

/// Property `magic`'s name, code (`None`: hand-written) and initial value.
fn property_of(magic: c_int) -> (&'static str, Option<i32>, Rec) {
    let s = specs();
    match s.properties.get(magic as usize) {
        Some(p) => (p.name, Some(p.code), literal(p.initial)),
        None => {
            let name = OWN_PROPERTIES[magic as usize - s.properties.len()];
            let initial = match name {
                "fillStyle" | "strokeStyle" => Rec::Str("#000".into()),
                _ => Rec::Num(0.0),
            };
            (name, None, initial)
        }
    }
}

fn rec_to_js(cx: *mut JsContext, r: &Rec) -> JsValue {
    match r {
        Rec::Bool(true) => qjs::JS_TRUE,
        Rec::Bool(false) => qjs::JS_FALSE,
        Rec::Num(n) => new_number(*n),
        Rec::Str(s) => new_string(cx, s),
        _ => qjs::JS_NULL,
    }
}

unsafe extern "C" fn property_get(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let (name, _, initial) = property_of(magic);
    match recording(cx, this).and_then(|r| r.state.get(name)) {
        // SAFETY: a dup of the kept value.
        Some(v) => unsafe { qjs::JS_DupValue(cx, v) },
        None => rec_to_js(cx, &initial),
    }
}

/// Keeps `value` (borrowed) as `name` in `r`'s drawing state.
fn keep(cx: *mut JsContext, r: &mut Recording, name: &'static str, value: JsValue) {
    // SAFETY: a dup the state owns; the old value is freed (a finalizer it
    // runs touches only its own object).
    let v = unsafe { qjs::JS_DupValue(cx, value) };
    match r.state.0.iter_mut().find(|(k, _)| *k == name) {
        Some(slot) => {
            let old = std::mem::replace(&mut slot.1, v);
            unsafe { qjs::JS_FreeValue(cx, old) };
        }
        None => r.state.0.push((name, v)),
    }
}

unsafe extern "C" fn property_set(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let (name, code, _) = property_of(magic);
    let value = arg(argc, argv, 0);
    let Some(r) = recording(cx, this) else {
        return throw_not_recording(cx);
    };
    keep(cx, r, name, value);
    match (name, code) {
        (_, Some(code)) => record(cx, this, code, &[value]),
        ("fillStyle", _) => record(cx, this, CV_FILL_STYLE, &[value]),
        ("strokeStyle", _) => record(cx, this, CV_STROKE_STYLE, &[value]),
        _ => {
            let zero = new_number(0.0);
            let x = r.state.get("shadowOffsetX").unwrap_or(zero);
            let y = r.state.get("shadowOffsetY").unwrap_or(zero);
            record(cx, this, CV_SHADOW_OFFSET, &[x, y])
        }
    }
}

/// `cx.canvas`: the size `draw` got.
unsafe extern "C" fn context_size(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    match recording(cx, this) {
        // SAFETY: a dup of the size.
        Some(r) => unsafe { qjs::JS_DupValue(cx, r.size) },
        None => UNDEFINED,
    }
}

/// A native (`fn(cx, this, args) -> JsValue`) over borrowed arguments.
macro_rules! native {
    ($(#[$doc:meta])* $name:ident, |$cx:ident, $this:ident, $args:ident| $body:expr) => {
        $(#[$doc])*
        unsafe extern "C" fn $name(
            $cx: *mut JsContext,
            $this: JsValue,
            argc: c_int,
            argv: *mut JsValue,
        ) -> JsValue {
            let $args: &[JsValue] = if argc <= 0 || argv.is_null() {
                &[]
            } else {
                // SAFETY: QuickJS passes `argc` live arguments.
                unsafe { std::slice::from_raw_parts(argv, argc as usize) }
            };
            $body
        }
    };
}

fn at(args: &[JsValue], i: usize) -> JsValue {
    args.get(i).copied().unwrap_or(UNDEFINED)
}

fn number(cx: *mut JsContext, v: JsValue) -> f64 {
    let mut n = 0f64;
    // SAFETY: converting a live value (a throwing `valueOf` gives NaN).
    if unsafe { qjs::JS_ToFloat64(cx, &mut n, v) } < 0 {
        unsafe { qjs::JS_FreeValue(cx, qjs::JS_GetException(cx)) };
        return f64::NAN;
    }
    n
}

native!(
    /// `roundRect(x, y, w, h, radii = 0)`: one radius, or 2–4 as in CSS
    /// `border-radius` (top-left first).
    round_rect,
    |cx, this, a| {
        let radii = at(a, 4);
        let mut r: Vec<JsValue> = Vec::new();
        // SAFETY: reads of a live array; the items got are freed below.
        unsafe {
            if qjs::JS_IsArray(radii) {
                let mut len: i64 = 0;
                qjs::JS_GetLength(cx, radii, &mut len);
                for i in 0..len.clamp(0, 4) {
                    r.push(qjs::JS_GetPropertyInt64(cx, radii, i));
                }
            } else if !is_undefined(radii) {
                r.push(qjs::JS_DupValue(cx, radii));
            }
        }
        let zero = new_number(0.0);
        let get = |i: usize| match r.get(i) {
            Some(&v) if !is_undefined(v) => v,
            _ => zero,
        };
        let [tl, tr, br, bl] = match r.len() {
            4 => [get(0), get(1), get(2), get(3)],
            3 => [get(0), get(1), get(2), get(1)],
            2 => [get(0), get(1), get(0), get(1)],
            _ => [get(0); 4],
        };
        let args = [at(a, 0), at(a, 1), at(a, 2), at(a, 3), tl, tr, br, bl];
        let out = record(cx, this, CV_ROUND_RECT, &args);
        free_values(cx, r);
        out
    }
);

/// Appends path `from`'s recording to path `to`'s.
fn append_path(cx: *mut JsContext, to: JsValue, from: JsValue) {
    let src = recording_ptr(cx, from);
    // SAFETY: the source is read and its values dup'd before the target is
    // borrowed (they may be the same path).
    let (ops, used) = match unsafe { src.as_ref() } {
        Some(r) => {
            let used: Vec<JsValue> = r
                .used
                .iter()
                .map(|&u| unsafe { qjs::JS_DupValue(cx, u) })
                .collect();
            (r.out.clone(), used)
        }
        None => return,
    };
    match recording(cx, to) {
        Some(r) => {
            r.out.extend(ops);
            r.used.extend(used);
        }
        None => free_values(cx, used),
    }
}

native!(
    /// `addPath(path)`: appends `path`'s subpaths.
    add_path,
    |cx, this, a| {
        append_path(cx, this, at(a, 0));
        UNDEFINED
    }
);

native!(save, |cx, this, _a| {
    if let Some(r) = recording(cx, this) {
        // SAFETY: dups for the saved state.
        let copy = r
            .state
            .0
            .iter()
            .map(|&(k, v)| (k, unsafe { qjs::JS_DupValue(cx, v) }));
        let copy = DrawState(copy.collect());
        r.stack.push(copy);
    }
    record(cx, this, CV_SAVE, &[])
});

native!(restore, |cx, this, _a| {
    let Some(r) = recording(cx, this) else {
        return UNDEFINED;
    };
    let Some(saved) = r.stack.pop() else {
        return UNDEFINED;
    };
    let old = std::mem::replace(&mut r.state, saved);
    free_values(cx, old.0.into_iter().map(|(_, v)| v));
    record(cx, this, CV_RESTORE, &[])
});

native!(reset_transform, |cx, this, _a| {
    let n = new_number;
    record(
        cx,
        this,
        CV_SET_TRANSFORM,
        &[n(1.0), n(0.0), n(0.0), n(1.0), n(0.0), n(0.0)],
    )
});

/// The numbers of array `v` (anything else: none).
fn numbers(cx: *mut JsContext, v: JsValue) -> Vec<f64> {
    let mut out = Vec::new();
    // SAFETY: reads of a live array; items are freed.
    unsafe {
        if qjs::JS_IsArray(v) {
            let mut len: i64 = 0;
            qjs::JS_GetLength(cx, v, &mut len);
            for i in 0..len.clamp(0, 1 << 16) {
                let item = qjs::JS_GetPropertyInt64(cx, v, i);
                out.push(number(cx, item));
                qjs::JS_FreeValue(cx, item);
            }
        }
    }
    out
}

fn number_array(cx: *mut JsContext, values: &[f64]) -> JsValue {
    let mut items: Vec<JsValue> = values.iter().map(|&n| new_number(n)).collect();
    // SAFETY: the array takes the items.
    unsafe { qjs::JS_NewArrayFrom(cx, items.len() as c_int, items.as_mut_ptr()) }
}

native!(
    /// `setLineDash(segments)`: a copy is kept for `getLineDash`.
    set_line_dash,
    |cx, this, a| {
        let copy = number_array(cx, &numbers(cx, at(a, 0)));
        if let Some(r) = recording(cx, this) {
            keep(cx, r, "lineDash", copy);
        }
        let out = record(cx, this, CV_LINE_DASH, &[copy]);
        free_values(cx, [copy]);
        out
    }
);

native!(
    /// `getLineDash()`: an odd count is repeated, as in canvas.
    get_line_dash,
    |cx, this, _a| {
        let kept = recording(cx, this).and_then(|r| r.state.get("lineDash"));
        let mut d = kept.map(|v| numbers(cx, v)).unwrap_or_default();
        if d.len() % 2 == 1 {
            d.extend_from_within(..);
        }
        number_array(cx, &d)
    }
);

fn is_path(cx: *mut JsContext, v: JsValue) -> bool {
    let c = classes(cx);
    // SAFETY: reading a live value's class.
    unsafe { qjs::JS_GetClassID(v) == c.path }
}

/// `fill` / `clip(path?, rule?)` (`fill(rule)` too).
fn fill_like(cx: *mut JsContext, this: JsValue, code: i32, a: &[JsValue]) -> JsValue {
    let (path, rule) = if is_path(cx, at(a, 0)) {
        (at(a, 0), at(a, 1))
    } else {
        (qjs::JS_NULL, at(a, 0))
    };
    if is_undefined(rule) {
        let nonzero = new_string(cx, "nonzero");
        let out = record(cx, this, code, &[path, nonzero]);
        free_values(cx, [nonzero]);
        out
    } else {
        record(cx, this, code, &[path, rule])
    }
}

native!(fill, |cx, this, a| fill_like(cx, this, CV_FILL, a));
native!(clip, |cx, this, a| fill_like(cx, this, CV_CLIP, a));
native!(stroke, |cx, this, a| {
    let path = if is_path(cx, at(a, 0)) {
        at(a, 0)
    } else {
        qjs::JS_NULL
    };
    record(cx, this, CV_STROKE, &[path])
});

/// `fillText` / `strokeText(text, x, y, maxWidth?)`.
fn text_like(cx: *mut JsContext, this: JsValue, code: i32, a: &[JsValue]) -> JsValue {
    // `String(text)`.
    // SAFETY: a new string (or the exception), freed after recording.
    let text = unsafe { qjs::JS_ToString(cx, at(a, 0)) };
    if unsafe { qjs::JS_IsException(text) } {
        return text;
    }
    let max = if is_undefined(at(a, 3)) {
        qjs::JS_NULL
    } else {
        at(a, 3)
    };
    let out = record(cx, this, code, &[text, at(a, 1), at(a, 2), max]);
    free_values(cx, [text]);
    out
}

native!(fill_text, |cx, this, a| text_like(
    cx,
    this,
    CV_FILL_TEXT,
    a
));
native!(stroke_text, |cx, this, a| text_like(
    cx,
    this,
    CV_STROKE_TEXT,
    a
));

native!(
    /// `measureText(text)`: measured by the platform's text engine with
    /// the current `font`.
    measure_text,
    |cx, this, a| {
        let text = dom::string_arg(cx, at(a, 0)).unwrap_or_default();
        let state = |name| {
            recording(cx, this)
                .and_then(|r| r.state.get(name))
                .and_then(|f| dom::string_arg(cx, f))
        };
        let numeric = state("fontVariantNumeric")
            .as_deref()
            .and_then(FontVariant::parse)
            .unwrap_or_default();
        let font = state("font")
            .as_deref()
            .and_then(CanvasFont::parse)
            .unwrap_or_default()
            .with_numeric(numeric);
        let shared = dom::shared(cx);
        let width = shared
            .measurer
            .borrow()
            .as_ref()
            .map_or(0.0, |m| m(&font, &text).0 as f64);
        // SAFETY: a new object.
        unsafe {
            let o = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(cx, o, c"width".as_ptr(), new_number(width));
            o
        }
    }
);

/// `isPointInPath([path,] x, y, rule?)` / `isPointInStroke([path,] x,
/// y)`: answered in Rust from what the context recorded so far (after
/// `draw` returned: all it drew), without the platform.
fn point_in(cx: *mut JsContext, this: JsValue, a: &[JsValue], stroke: bool) -> JsValue {
    let Some(r) = recording(cx, this) else {
        return throw_not_recording(cx);
    };
    let recorded = match &r.drawn {
        Some(d) if r.closed => d.clone(),
        _ => Rc::new(r.out.clone()),
    };
    let (path, rest) = if is_path(cx, at(a, 0)) {
        (Some(at(a, 0)), a.get(1..).unwrap_or_default())
    } else {
        (None, a)
    };
    let (x, y) = (
        number(cx, at(rest, 0)) as f32,
        number(cx, at(rest, 1)) as f32,
    );
    let rule = match dom::string_arg(cx, at(rest, 2)).as_deref() {
        Some("evenodd") => FillRule::EvenOdd,
        _ => FillRule::NonZero,
    };
    let path = path.and_then(|p| {
        let mut used = Vec::new();
        let rec = to_rec(cx, p, &mut used, 0);
        free_values(cx, used);
        let list = RecList(Rc::new(vec![Rec::Num(CV_STROKE as f64), rec]));
        match decode(&list, 0, 2).ok()?.ops.pop()? {
            CanvasOp::Stroke(path) => path,
            _ => None,
        }
    });
    let len = recorded.len();
    let Ok(drawing) = decode(&RecList(recorded), 0, len) else {
        return qjs::JS_FALSE;
    };
    // JS does not see animated values' current values: they count as 0.
    let slot = |_| 0.0;
    let point = nsh_core::geometry::point(nsh_core::Points(x), nsh_core::Points(y));
    let hit = if stroke {
        point_in_stroke(&drawing.ops, path.as_deref(), point, slot)
    } else {
        point_in_path(&drawing.ops, path.as_deref(), rule, point, slot)
    };
    if hit { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

native!(is_point_in_path, |cx, this, a| point_in(cx, this, a, false));
native!(is_point_in_stroke, |cx, this, a| point_in(
    cx, this, a, true
));

/// A gradient of `kind` (0 linear, 1 radial, 2 conic) over `count`
/// numbers of `a`: its recording is `[kind, ...geometry, stops]`, the
/// stops list filled by `addColorStop`.
fn gradient(cx: *mut JsContext, kind: f64, a: &[JsValue], count: usize) -> JsValue {
    let c = classes(cx);
    let g = new_recording(cx, c.gradient);
    let geometry: Vec<Rec> = (0..count).map(|i| Rec::Num(number(cx, at(a, i)))).collect();
    if let Some(r) = recording(cx, g) {
        r.out.push(Rec::Num(kind));
        r.out.extend(geometry);
        r.out.push(Rec::List(Rc::new(Vec::new())));
    }
    g
}

native!(linear_gradient, |cx, _this, a| gradient(cx, 0.0, a, 4));
native!(radial_gradient, |cx, _this, a| gradient(cx, 1.0, a, 6));
native!(
    /// `createConicGradient(startAngle, x, y)`: the angle in radians,
    /// clockwise from the x axis.
    conic_gradient,
    |cx, _this, a| gradient(cx, 2.0, a, 3)
);

native!(
    /// `addColorStop(offset, color)`: offset 0..1, any CSS color.
    add_color_stop,
    |cx, this, a| {
        let offset = number(cx, at(a, 0));
        let color = rc_str(cx, at(a, 1));
        if let Some(r) = recording(cx, this)
            && let Some(Rec::List(stops)) = r.out.last_mut()
        {
            let stops = Rc::make_mut(stops);
            stops.push(Rec::Num(offset));
            stops.push(Rec::Str(color));
        }
        UNDEFINED
    }
);

native!(
    /// `drawImage(image, dx, dy)` at its natural size, `(image, dx, dy,
    /// dw, dh)`, or `(image, sx, sy, sw, sh, dx, dy, dw, dh)` (source in
    /// image pixels); `image` is a URL or an imported asset.
    draw_image,
    |cx, this, a| {
        let image = at(a, 0);
        let nan = || new_number(f64::NAN);
        // SAFETY: reads of a live value; the values got are freed below.
        let (uri, width, height) = unsafe {
            if qjs::JS_IsString(image) {
                (qjs::JS_DupValue(cx, image), nan(), nan())
            } else if qjs::JS_IsObject(image) {
                // An imported asset: `{ url, size: { width, height } }`.
                let size = qjs::JS_GetPropertyStr(cx, image, c"size".as_ptr());
                let side = |key: &std::ffi::CStr| {
                    if !qjs::JS_IsObject(size) {
                        return nan();
                    }
                    let v = qjs::JS_GetPropertyStr(cx, size, key.as_ptr());
                    if is_undefined(v) { nan() } else { v }
                };
                let (width, height) = (side(c"width"), side(c"height"));
                free_values(cx, [size]);
                (
                    qjs::JS_GetPropertyStr(cx, image, c"url".as_ptr()),
                    width,
                    height,
                )
            } else {
                (UNDEFINED, nan(), nan())
            }
        };
        let rest = a.get(1..).unwrap_or(&[]);
        let out = if rest.len() >= 8 {
            // SAFETY: dups the array takes.
            let mut src: Vec<JsValue> = rest[..4]
                .iter()
                .map(|&v| unsafe { qjs::JS_DupValue(cx, v) })
                .collect();
            let src = unsafe { qjs::JS_NewArrayFrom(cx, 4, src.as_mut_ptr()) };
            let args = [uri, src, rest[4], rest[5], rest[6], rest[7]];
            let out = record(cx, this, CV_DRAW_IMAGE, &args);
            free_values(cx, [src]);
            out
        } else if rest.len() >= 4 {
            let args = [uri, qjs::JS_NULL, rest[0], rest[1], rest[2], rest[3]];
            record(cx, this, CV_DRAW_IMAGE, &args)
        } else {
            let zero = new_number(0.0);
            let or_zero = |v: JsValue| if is_undefined(v) { zero } else { v };
            let (dx, dy) = (or_zero(at(rest, 0)), or_zero(at(rest, 1)));
            let args = [uri, qjs::JS_NULL, dx, dy, width, height];
            record(cx, this, CV_DRAW_IMAGE, &args)
        };
        free_values(cx, [uri, width, height]);
        out
    }
);

/// `new Path2D(path?)`: a path to fill, stroke or clip; a copy of another
/// path, or SVG path data (parsed natively).
unsafe extern "C" fn path_2d(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let c = classes(cx);
    let path = new_recording(cx, c.path);
    let from = arg(argc, argv, 0);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsString(from) } {
        let svg = rc_str(cx, from);
        if let Some(r) = recording(cx, path) {
            r.out.push(Rec::Num(CV_SVG_PATH as f64));
            r.out.push(Rec::Str(svg));
        }
    } else if is_path(cx, from) {
        append_path(cx, path, from);
    }
    path
}

/// The objects of contexts and gradients are made by contexts, as in
/// browsers.
unsafe extern "C" fn illegal_constructor(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    // SAFETY: throws on a live context.
    unsafe { qjs::JS_ThrowTypeError(cx, c"Illegal constructor".as_ptr()) }
}

/// Class `index`'s constructor `name` (for `new` and `instanceof`).
fn class_function(
    cx: *mut JsContext,
    name: &CStr,
    f: Native,
    index: usize,
    length: c_int,
) -> JsValue {
    classes(cx);
    let proto = canvases(cx).protos.get()[index];
    // SAFETY: a constructor-or-function whose `prototype` is the class's.
    unsafe {
        let func = qjs::JS_NewCFunction2(
            cx,
            Some(f),
            name.as_ptr(),
            length,
            qjs::JSCFunctionEnum_JS_CFUNC_constructor_or_func,
            0,
        );
        qjs::JS_SetConstructor(cx, func, proto);
        func
    }
}

// --- Canvas ------------------------------------------------------------------------

/// `<Canvas draw={(cx, size) => …}>`: a view drawn with a 2D context.
/// `draw` runs once the size is known, and again when the size or the
/// signals it reads change; animated values passed as numbers or colors
/// animate without running it.
unsafe extern "C" fn canvas(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    let node = match dom::create_element(cx, Tag::Canvas) {
        Ok(node) => node,
        Err(e) => return e,
    };
    let made = (|| -> Result<(), JsValue> {
        dom::spread_except(cx, node, props, &["draw", "onLayout"])?;
        let size = reactive::new_signal(cx, qjs::JS_NULL);
        let mut data = [size, props];
        // SAFETY: the functions keep dups of `data`; ours are freed.
        let on_layout = unsafe {
            qjs::JS_NewCFunctionData(cx, Some(canvas_layout), 1, 0, 2, data.as_mut_ptr())
        };
        let id = dom::node_id(cx, node).unwrap_or(0);
        let set = dom::set_handler(cx, id, EventKind::Layout, on_layout);
        unsafe { qjs::JS_FreeValue(cx, on_layout) };
        let mut data = [node, props, size];
        let draw =
            unsafe { qjs::JS_NewCFunctionData(cx, Some(canvas_draw), 0, 0, 3, data.as_mut_ptr()) };
        unsafe { qjs::JS_FreeValue(cx, size) };
        if let Err(e) = set {
            unsafe { qjs::JS_FreeValue(cx, draw) };
            return Err(e);
        }
        let r = reactive::render_effect(cx, draw);
        unsafe { qjs::JS_FreeValue(cx, r) };
        let r = reactive::finish_value(cx, UNDEFINED);
        if unsafe { qjs::JS_IsException(r) } {
            Err(r)
        } else {
            Ok(())
        }
    })();
    match made {
        Ok(()) => node,
        Err(e) => {
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, node) };
            e
        }
    }
}

/// The canvas's `onLayout`: the size (when it changed), then the app's.
unsafe extern "C" fn canvas_layout(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (size signal, props); values got are freed.
    unsafe {
        let (size, props) = (*data, *data.add(1));
        let e = arg(argc, argv, 0);
        let field = |o: JsValue, k: &CStr| {
            let v = qjs::JS_GetPropertyStr(cx, o, k.as_ptr());
            let n = number(cx, v);
            qjs::JS_FreeValue(cx, v);
            n
        };
        // `e` is the view's `Bounds`.
        let bounds_size = qjs::JS_GetPropertyStr(cx, e, c"size".as_ptr());
        let (w, h) = (field(bounds_size, c"width"), field(bounds_size, c"height"));
        qjs::JS_FreeValue(cx, bounds_size);
        let current = reactive::peek(cx, size);
        let same = qjs::JS_IsObject(current)
            && field(current, c"width") == w
            && field(current, c"height") == h;
        if !same {
            let s = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(cx, s, c"width".as_ptr(), new_number(w));
            qjs::JS_SetPropertyStr(cx, s, c"height".as_ptr(), new_number(h));
            reactive::set_signal(cx, size, s);
        }
        let own = qjs::JS_GetPropertyStr(cx, props, c"onLayout".as_ptr());
        let r = if qjs::JS_IsFunction(cx, own) {
            let mut args = [e];
            qjs::JS_Call(cx, own, UNDEFINED, 1, args.as_mut_ptr())
        } else {
            UNDEFINED
        };
        qjs::JS_FreeValue(cx, own);
        let done = reactive::finish_value(cx, UNDEFINED);
        if qjs::JS_IsException(done) {
            qjs::JS_FreeValue(cx, r);
            return done;
        }
        r
    }
}

/// The drawing effect: once the size is known, records `draw(cx, size)`
/// and sends it.
unsafe extern "C" fn canvas_draw(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (node, props, size signal); the values
    // made here are freed or handed on.
    unsafe {
        let (node, props, size_signal) = (*data, *data.add(1), *data.add(2));
        let size = qjs::JS_Call(cx, size_signal, UNDEFINED, 0, ptr::null_mut());
        if qjs::JS_IsException(size) {
            return size;
        }
        if !qjs::JS_IsObject(size) {
            qjs::JS_FreeValue(cx, size);
            return UNDEFINED;
        }
        let c = classes(cx);
        let context = new_recording(cx, c.context);
        if qjs::JS_IsException(context) {
            qjs::JS_FreeValue(cx, size);
            return context;
        }
        if let Some(r) = recording(cx, context) {
            r.size = qjs::JS_DupValue(cx, size);
        }
        let draw = qjs::JS_GetPropertyStr(cx, props, c"draw".as_ptr());
        let mut args = [context, size];
        let called = qjs::JS_Call(cx, draw, UNDEFINED, 2, args.as_mut_ptr());
        free_values(cx, [draw, size]);
        let (out, used) = match recording(cx, context) {
            Some(r) => {
                r.closed = true;
                let out = Rc::new(std::mem::take(&mut r.out));
                r.drawn = Some(out.clone());
                (out, std::mem::take(&mut r.used))
            }
            None => (Rc::default(), Vec::new()),
        };
        qjs::JS_FreeValue(cx, context);
        // What was recorded is drawn even when `draw` threw (then rethrown).
        let sent = send(cx, node, out, used);
        if qjs::JS_IsException(called) {
            if qjs::JS_IsException(sent) {
                qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            }
            return called;
        }
        qjs::JS_FreeValue(cx, called);
        sent
    }
}

/// Sends drawing `out` of `node`, which keeps the animated values it reads
/// (`used`, owned) alive.
fn send(cx: *mut JsContext, node: JsValue, out: Rc<Vec<Rec>>, mut used: Vec<JsValue>) -> JsValue {
    let shared = dom::shared(cx);
    let max = shared.limits.max_canvas_ops;
    if out.len() > max {
        free_values(cx, used);
        let reason = format!(
            "a canvas drawing recorded {} values (limit {max}) and the app was stopped",
            out.len()
        );
        shared.stop(reason.clone());
        let message = CString::new(reason).unwrap_or_default();
        // SAFETY: throws on a live context; `%s` keeps the message literal.
        return unsafe { qjs::JS_ThrowRangeError(cx, c"%s".as_ptr(), message.as_ptr()) };
    }
    let len = out.len();
    let drawing = decode(&RecList(out), 0, len);
    // SAFETY: the array takes the values.
    let array = unsafe { qjs::JS_NewArrayFrom(cx, used.len() as c_int, used.as_mut_ptr()) };
    dom::retain(cx, node, "draw", array);
    free_values(cx, [array]);
    let drawing = match drawing {
        Ok(d) => d,
        Err(e) => {
            let message = CString::new(format!("nsh canvas: {e}")).unwrap_or_default();
            // SAFETY: as above.
            return unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) };
        }
    };
    let id = dom::node_id(cx, node).unwrap_or(0);
    let op = Op::Draw {
        id,
        drawing: Box::new(drawing),
    };
    match dom::push_op(cx, op) {
        Ok(()) => UNDEFINED,
        Err(e) => e,
    }
}

/// `nsh/canvas`.
pub(crate) const EXPORTS: &[Item] = &[
    (
        "Canvas",
        Export::Function(canvas, 1),
        Ts::function(
            "A view drawn with a 2D context (HTML Canvas 2D API). `draw` records the\ndrawing in one go; the platform replays it natively (CGContext, Android\nCanvas), at the screen's resolution.",
            &["(props: CanvasProps): YNode"],
        ),
    ),
    (
        "Path2D",
        Export::Value(|cx| class_function(cx, c"Path2D", path_2d, PATH, 1)),
        Ts::class(
            "A path to fill, stroke or clip; `new Path2D(\"M0 0 L10 10\")` takes SVG\npath data (parsed natively).",
            r#" {
  #private;
  constructor(path?: Path2D | string);
  /** Appends `path`'s subpaths. */
  addPath(path: Path2D): void;
}
export interface Path2D extends CanvasPath {}"#,
        ),
    ),
    (
        "CanvasRenderingContext2D",
        Export::Value(|cx| {
            let name = c"CanvasRenderingContext2D";
            class_function(cx, name, illegal_constructor, CONTEXT, 0)
        }),
        Ts::class(
            "The 2D context `<Canvas draw>` gets (an HTML Canvas 2D subset). Calls only\nrecord operations; the platform draws them after `draw` returns (and again\nwhenever an animated value they read changes). Coordinates are in points,\nthe origin at the canvas's top left.",
            r#" {
  #private;
  /** The canvas's size in points. */
  readonly canvas: { readonly width: number; readonly height: number };
  fillStyle: CanvasPaint;
  strokeStyle: CanvasPaint;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  resetTransform(): void;
  setLineDash(segments: number[]): void;
  getLineDash(): number[];
  fill(path?: Path2D | "nonzero" | "evenodd", rule?: "nonzero" | "evenodd"): void;
  stroke(path?: Path2D): void;
  clip(path?: Path2D | "nonzero" | "evenodd", rule?: "nonzero" | "evenodd"): void;
  fillText(text: string, x: CanvasNumber, y: CanvasNumber, maxWidth?: number): void;
  strokeText(text: string, x: CanvasNumber, y: CanvasNumber, maxWidth?: number): void;
  /** Measured by the platform's text engine with the current `font`. */
  measureText(text: string): TextMetrics;
  /**
   * Whether (`x`, `y`) (in points, not transformed) is inside `path` under
   * the current transform, or inside the current path; answered natively
   * from what was recorded (after `draw` returned: everything it drew, so a
   * kept context answers in press handlers). Animated values count as 0.
   */
  isPointInPath(x: number, y: number, rule?: "nonzero" | "evenodd"): boolean;
  isPointInPath(path: Path2D, x: number, y: number, rule?: "nonzero" | "evenodd"): boolean;
  /**
   * Whether (`x`, `y`) is on the stroke of `path` or the current path, with
   * the current `lineWidth` and `lineCap` (joins as round, no dashes).
   */
  isPointInStroke(x: number, y: number): boolean;
  isPointInStroke(path: Path2D, x: number, y: number): boolean;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
  /** `startAngle` in radians, clockwise from the x axis. */
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient;
  /**
   * Draws an image (a URL or an imported asset), loaded natively:
   * `(image, dx, dy)` at its natural size, `(image, dx, dy, dw, dh)`, or
   * `(image, sx, sy, sw, sh, dx, dy, dw, dh)` for part of it (source in
   * image pixels). The canvas draws again once it has loaded.
   */
  drawImage(image: string | ImageAsset, ...args: CanvasNumber[]): void;
}
export interface CanvasRenderingContext2D extends CanvasPath, CanvasContextMethods, CanvasProperties {}"#,
        ),
    ),
    (
        "CanvasGradient",
        Export::Value(|cx| class_function(cx, c"CanvasGradient", illegal_constructor, GRADIENT, 0)),
        Ts::class(
            "A gradient from `createLinearGradient` / `createRadialGradient` /\n`createConicGradient`.",
            r#" {
  #private;
  /** `offset` 0..1; any CSS color. */
  addColorStop(offset: number, color: string): void;
}"#,
        ),
    ),
];

/// `nsh/canvas`'s types (with the recording methods' and properties' of
/// `nsh_core::js::canvas::declarations`).
pub(crate) const TYPES: &str = r#"/** A color, a gradient, or an animated value interpolating colors. */
export type CanvasPaint = string | CanvasGradient | AnimatedNode;

/** Path building, shared by the context (its current path) and `Path2D`. */
export interface CanvasPath extends CanvasPathMethods {
  /** `radii`: one radius, or 2–4 as in CSS `border-radius` (top-left first). */
  roundRect(x: CanvasNumber, y: CanvasNumber, w: CanvasNumber, h: CanvasNumber, radii?: CanvasNumber | CanvasNumber[]): void;
}

export interface TextMetrics {
  /** The advance width in points. */
  width: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasProps extends ViewProps {
  /**
   * Draws the canvas. Runs again when signals it reads change and when the
   * canvas resizes (it first runs once the size is known); animated values
   * passed as numbers or colors animate without running it.
   */
  draw: (cx: CanvasRenderingContext2D, size: CanvasSize) => void;
}
"#;
