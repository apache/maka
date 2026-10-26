//! `nsh/animated`: animated values and the animation graph (`AnimatedNode`,
//! `AnimatedValue`, `Animated`'s drivers and composites, keyframes),
//! motions (`createMotion`, `motions`), `Easing` and `LayoutAnimation`.
//! Everything runs on the UI thread, JS only describes it: keyframes and
//! motions are composites whose trees the core makes from their configs
//! (`nsh_core::animation::motion`).
//!
//! Operations are encoded as a few values (`ANIMATION_*`) and decoded into
//! `AnimationOp`s (`protocol::decode_animation_op`). Nodes and composites are
//! released when JS lets go of them (their finalizers queue the release); a
//! promise of a started animation settles when the core reports its end
//! (`Host::animations_finished`).

use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, CString, c_int, c_void},
    ptr,
};

use nsh_core::{
    animation::{AnimationOp, MotionChannel},
    js::protocol::*,
};
use rquickjs::{Ctx, Value, qjs};
use rustc_hash::FxHashMap;

use crate::{
    dom,
    modules::{Export, Item, Ts},
    reactive::{self, Native, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The animations' part of a context's state.
pub(crate) struct Animations {
    classes: Cell<Option<Classes>>,
    /// The prototypes (owned): node, value, composite.
    protos: Cell<[JsValue; 3]>,
    /// Even ids: the core gives Rust components' nodes, animations and
    /// composites odd ones.
    next_node: Cell<u32>,
    next_animation: Cell<u32>,
    next_composite: Cell<u32>,
    /// Promises of started animations and value reads, by id.
    ends: RefCell<FxHashMap<u32, End>>,
    /// Live composites by key (their finalizers take them out): a run going
    /// on does not keep its composite alive, so the values it animates go
    /// (and stop it) once nothing else holds them.
    composites: RefCell<FxHashMap<u32, *mut CompositeData>>,
    /// Live derived nodes by a hash of the operation that made them (its
    /// node 0): deriving the same node again (a canvas drawing again, a
    /// binding running again) gets the same node instead of a new one
    /// in the graph. The objects are not owned (their finalizers take them
    /// out).
    derived: RefCell<DerivedNodes>,
}

/// Derived nodes by hash: their operation (node 0), id and object.
type DerivedNodes = FxHashMap<u64, Vec<(AnimationOp, u32, JsValue)>>;

/// What a started animation or a value read settles.
struct End {
    /// Owned.
    resolve: JsValue,
    /// Owned, or undefined.
    callback: JsValue,
    /// The composite's key (0: none).
    composite: u32,
    /// Resolves with the value read rather than with `finished`.
    read: bool,
}

#[derive(Clone, Copy)]
struct Classes {
    node: qjs::JSClassID,
    composite: qjs::JSClassID,
}

impl Default for Animations {
    fn default() -> Self {
        Animations {
            classes: Cell::new(None),
            protos: Cell::new([UNDEFINED; 3]),
            next_node: Cell::new(2),
            next_animation: Cell::new(2),
            next_composite: Cell::new(2),
            ends: RefCell::new(FxHashMap::default()),
            composites: RefCell::new(FxHashMap::default()),
            derived: RefCell::new(FxHashMap::default()),
        }
    }
}

impl Animations {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        // SAFETY: owned values; no JS runs from here on.
        unsafe {
            for p in self.protos.replace([UNDEFINED; 3]) {
                qjs::JS_FreeValue(raw, p);
            }
            for (_, end) in self.ends.borrow_mut().drain() {
                qjs::JS_FreeValue(raw, end.resolve);
                qjs::JS_FreeValue(raw, end.callback);
            }
        }
        self.composites.borrow_mut().clear();
        self.derived.borrow_mut().clear();
    }
}

fn animations<'a>(cx: *mut JsContext) -> &'a Animations {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).animations }
}

/// A node's data: its id and the nodes it reads (kept alive with it).
struct NodeData {
    id: u32,
    inputs: Vec<JsValue>,
    /// The hash it is remembered by in `Animations::derived`.
    derived: Option<u64>,
}

/// A composite's data: its key, the running animation's id (0: none),
/// its spec and the values it animates (owned).
struct CompositeData {
    key: u32,
    running: u32,
    spec: JsValue,
    values: Vec<JsValue>,
}

unsafe extern "C" fn node_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of a node object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut NodeData;
    if p.is_null() {
        return;
    }
    let data = unsafe { Box::from_raw(p) };
    if let Some(state) = crate::state::of_runtime(rt) {
        // Not the op queue: a finalizer may run while it is borrowed.
        unsafe { &(*state).dom }.queue_animation_release(AnimationOp::Release { node: data.id });
        if let Some(hash) = data.derived {
            // SAFETY: the state's animations, borrowed briefly (no JS runs
            // while the map is borrowed).
            let animations = unsafe { &(*state).animations };
            if let Ok(mut map) = animations.derived.try_borrow_mut()
                && let Some(list) = map.get_mut(&hash)
            {
                list.retain(|&(_, id, _)| id != data.id);
                if list.is_empty() {
                    map.remove(&hash);
                }
            }
        }
    }
    for v in data.inputs {
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
}

unsafe extern "C" fn node_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const NodeData;
    if !p.is_null() {
        for &v in unsafe { &(*p).inputs } {
            unsafe { qjs::JS_MarkValue(rt, v, mark) };
        }
    }
}

unsafe extern "C" fn composite_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of a composite object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut CompositeData;
    if p.is_null() {
        return;
    }
    let data = unsafe { Box::from_raw(p) };
    if let Some(state) = crate::state::of_runtime(rt) {
        unsafe { &(*state).dom }
            .queue_animation_release(AnimationOp::ReleaseComposite { key: data.key });
        // SAFETY: the state's animations, borrowed briefly.
        if let Ok(mut map) = unsafe { &(*state).animations }.composites.try_borrow_mut() {
            map.remove(&data.key);
        }
    }
    unsafe { qjs::JS_FreeValueRT(rt, data.spec) };
    for v in data.values {
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
}

unsafe extern "C" fn composite_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const CompositeData;
    if !p.is_null() {
        unsafe { qjs::JS_MarkValue(rt, (*p).spec, mark) };
        for &v in unsafe { &(*p).values } {
            unsafe { qjs::JS_MarkValue(rt, v, mark) };
        }
    }
}

/// Registers the classes and prototypes (once per context).
fn classes(cx: *mut JsContext) -> Classes {
    let a = animations(cx);
    if let Some(c) = a.classes.get() {
        return c;
    }
    // SAFETY: registering classes on the context's runtime; prototypes
    // take their methods.
    unsafe {
        let rt = qjs::JS_GetRuntime(cx);
        let class =
            |name: &'static CStr, finalizer: qjs::JSClassFinalizer, mark: qjs::JSClassGCMark| {
                let mut id: qjs::JSClassID = 0;
                qjs::JS_NewClassID(rt, &mut id);
                let def = qjs::JSClassDef {
                    class_name: name.as_ptr(),
                    finalizer,
                    gc_mark: mark,
                    call: None,
                    exotic: ptr::null_mut(),
                };
                qjs::JS_NewClass(rt, id, &def);
                id
            };
        let classes = Classes {
            node: class(c"AnimatedNode", Some(node_finalize), Some(node_mark)),
            composite: class(
                c"CompositeAnimation",
                Some(composite_finalize),
                Some(composite_mark),
            ),
        };
        let methods = |obj: JsValue, list: &[(&CStr, Native, c_int)]| {
            for &(name, f, length) in list {
                let func = reactive::new_function(cx, name, f, length);
                qjs::JS_SetPropertyStr(cx, obj, name.as_ptr(), func);
            }
        };
        let node_proto = qjs::JS_NewObject(cx);
        methods(
            node_proto,
            &[
                (c"interpolate", node_interpolate, 1),
                (c"diffClamp", node_diff_clamp, 2),
                (c"add", node_add, 1),
                (c"sub", node_sub, 1),
                (c"mul", node_mul, 1),
                (c"div", node_div, 1),
                (c"mod", node_mod, 1),
            ],
        );
        let value_proto = qjs::JS_NewObjectProto(cx, node_proto);
        methods(
            value_proto,
            &[
                (c"set", value_set, 1),
                (c"adjust", value_adjust, 2),
                (c"stop", value_stop, 0),
                (c"getValue", value_get, 0),
                (c"setOffset", value_set_offset, 1),
                (c"flattenOffset", value_flatten_offset, 0),
                (c"extractOffset", value_extract_offset, 0),
                (c"timing", value_timing, 2),
                (c"spring", value_spring, 2),
                (c"decay", value_decay, 1),
                (c"keyframes", value_keyframes, 2),
            ],
        );
        let composite_proto = qjs::JS_NewObject(cx);
        methods(
            composite_proto,
            &[
                (c"start", composite_start, 1),
                (c"stop", composite_stop, 0),
                (c"reset", composite_reset, 0),
            ],
        );
        qjs::JS_SetClassProto(cx, classes.composite, qjs::JS_DupValue(cx, composite_proto));
        a.protos.set([node_proto, value_proto, composite_proto]);
        a.classes.set(Some(classes));
        classes
    }
}

/// Decodes an encoded animation operation (`ANIMATION_*`, the node, its
/// values) and queues it. Takes `values`.
fn send(cx: *mut JsContext, values: Vec<JsValue>) -> Result<(), JsValue> {
    let op = decode(cx, values)?;
    dom::push_op(cx, nsh_core::Op::Animation(op))
}

/// Decodes an encoded animation operation. Takes `values`.
fn decode(cx: *mut JsContext, values: Vec<JsValue>) -> Result<AnimationOp, JsValue> {
    let mut values = values;
    // SAFETY: an array taking the values, read by the decoder through a
    // context reference.
    let array = unsafe { qjs::JS_NewArrayFrom(cx, values.len() as c_int, values.as_mut_ptr()) };
    let js_cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(cx)) };
    let value = unsafe { Value::from_raw(js_cx.clone(), array) };
    let Some(array) = value.as_array() else {
        return Err(qjs::JS_EXCEPTION);
    };
    match crate::protocol::decode_animation_op(&js_cx, array) {
        Ok(op) => Ok(op),
        Err(rquickjs::Error::Exception) => Err(qjs::JS_EXCEPTION),
        Err(e) => {
            let message = CString::new(format!("nsh/animated: {e}")).unwrap_or_default();
            // SAFETY: throws on a live context.
            Err(unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) })
        }
    }
}

fn int(v: impl Into<f64>) -> JsValue {
    qjs::JS_NewFloat64(v.into())
}

fn string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

fn dup(cx: *mut JsContext, v: JsValue) -> JsValue {
    // SAFETY: a live value.
    unsafe { qjs::JS_DupValue(cx, v) }
}

fn free(cx: *mut JsContext, v: JsValue) {
    // SAFETY: an owned value.
    unsafe { qjs::JS_FreeValue(cx, v) };
}

fn get(cx: *mut JsContext, obj: JsValue, key: &CStr) -> JsValue {
    // SAFETY: a property read of a live value.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        qjs::JS_GetPropertyStr(cx, obj, key.as_ptr())
    }
}

/// A new node object (`value`: a `AnimatedValue`) reading `inputs` (taken).
fn new_node(cx: *mut JsContext, value: bool, inputs: Vec<JsValue>) -> (JsValue, u32) {
    let c = classes(cx);
    let a = animations(cx);
    let id = a.next_node.get();
    a.next_node.set(id + 2);
    let proto = a.protos.get()[if value { 1 } else { 0 }];
    let data = Box::into_raw(Box::new(NodeData {
        id,
        inputs,
        derived: None,
    }));
    // SAFETY: an object of the node class owning its data; `__av` is what
    // the prop decoder reads.
    unsafe {
        let obj = qjs::JS_NewObjectProtoClass(cx, proto, c.node);
        qjs::JS_SetOpaque(obj, data as *mut c_void);
        qjs::JS_SetPropertyStr(cx, obj, c"__av".as_ptr(), int(id));
        (obj, id)
    }
}

/// The id of node object `v`, if it is one.
fn node_id(cx: *mut JsContext, v: JsValue) -> Option<u32> {
    let c = classes(cx);
    // SAFETY: the opaque of a node object.
    let p = unsafe { qjs::JS_GetOpaque(v, c.node) } as *const NodeData;
    (!p.is_null()).then(|| unsafe { (*p).id })
}

fn this_node(cx: *mut JsContext, this: JsValue) -> Result<u32, JsValue> {
    node_id(cx, this).ok_or_else(|| {
        // SAFETY: throws on a live context.
        unsafe { qjs::JS_ThrowTypeError(cx, c"not an animated node".as_ptr()) }
    })
}

/// A node reading `inputs` (taken) made by encoded operation `sub` with
/// `args`: the live node made by the same operation if there is one.
fn derived(cx: *mut JsContext, inputs: Vec<JsValue>, sub: i32, args: Vec<JsValue>) -> JsValue {
    let mut values = vec![int(sub), int(0)];
    values.extend(args);
    let key = match decode(cx, values) {
        Ok(op) => op,
        Err(e) => {
            for v in inputs {
                free(cx, v);
            }
            return e;
        }
    };
    let a = animations(cx);
    let hash = derived_hash(&key);
    let existing = a.derived.borrow().get(&hash).and_then(|list| {
        list.iter()
            .find(|(op, ..)| *op == key)
            .map(|&(.., obj)| obj)
    });
    if let Some(obj) = existing {
        for v in inputs {
            free(cx, v);
        }
        return dup(cx, obj);
    }
    let (node, id) = new_node(cx, false, inputs);
    let c = classes(cx);
    // SAFETY: the node object's own data.
    unsafe { (*(qjs::JS_GetOpaque(node, c.node) as *mut NodeData)).derived = Some(hash) };
    a.derived
        .borrow_mut()
        .entry(hash)
        .or_default()
        .push((key.clone(), id, node));
    match dom::push_op(cx, nsh_core::Op::Animation(with_node(key, id))) {
        Ok(()) => node,
        Err(e) => {
            free(cx, node);
            e
        }
    }
}

/// `op` making node `id`.
fn with_node(mut op: AnimationOp, id: u32) -> AnimationOp {
    match &mut op {
        AnimationOp::CreateInterpolate { node, .. }
        | AnimationOp::CreateDiffClamp { node, .. }
        | AnimationOp::CreateMath { node, .. } => *node = id,
        _ => {}
    }
    op
}

/// A hash of a derived node's operation (operations equal by `==` hash the
/// same: `-0.0` is `0.0`).
fn derived_hash(op: &AnimationOp) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = rustc_hash::FxHasher::default();
    let mut f = |x: f32| (if x == 0.0 { 0.0f32 } else { x }).to_bits().hash(&mut h);
    let mut kind = 0u8;
    let mut ids = [0u32; 2];
    match op {
        AnimationOp::CreateInterpolate {
            input,
            input_range,
            output,
            ..
        } => {
            ids[0] = *input;
            for &x in input_range {
                f(x);
            }
            match output {
                nsh_core::animation::Output::Numbers(v) => v.iter().for_each(|&x| f(x)),
                nsh_core::animation::Output::Colors(v) => {
                    v.iter().for_each(|&c| f(f32::from_bits(c)))
                }
            }
        }
        AnimationOp::CreateDiffClamp {
            input,
            min,
            max,
            snap,
            ..
        } => {
            kind = 1;
            ids[0] = *input;
            f(*min);
            f(*max);
            snap.hash(&mut h);
        }
        AnimationOp::CreateMath { a, b, .. } => {
            kind = 2;
            for (i, o) in [a, b].into_iter().enumerate() {
                match *o {
                    nsh_core::animation::Operand::Node(n) => ids[i] = n,
                    nsh_core::animation::Operand::Const(c) => f(c),
                }
            }
        }
        _ => kind = 3,
    }
    kind.hash(&mut h);
    ids.hash(&mut h);
    h.finish()
}

unsafe extern "C" fn node_interpolate(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let input = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let config = arg(argc, argv, 0);
    let both = get(cx, config, c"extrapolate");
    let both = if unsafe { qjs::JS_IsUndefined(both) } {
        string(cx, "clamp")
    } else {
        both
    };
    let side = |key: &CStr| {
        let v = get(cx, config, key);
        if unsafe { qjs::JS_IsUndefined(v) } {
            dup(cx, both)
        } else {
            v
        }
    };
    let easing = get(cx, config, c"easing");
    let easing = if unsafe { qjs::JS_IsUndefined(easing) } {
        string(cx, "linear")
    } else {
        easing
    };
    let args = vec![
        int(input),
        get(cx, config, c"inputRange"),
        get(cx, config, c"outputRange"),
        side(c"extrapolateLeft"),
        side(c"extrapolateRight"),
        easing,
    ];
    free(cx, both);
    derived(cx, vec![dup(cx, this)], ANIMATION_INTERPOLATE, args)
}

unsafe extern "C" fn node_diff_clamp(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let input = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let args = vec![
        int(input),
        dup(cx, arg(argc, argv, 0)),
        dup(cx, arg(argc, argv, 1)),
        // `{ snap }`: settles at the nearer bound when its scroll view
        // rests (undefined without options).
        get(cx, arg(argc, argv, 2), c"snap"),
    ];
    derived(cx, vec![dup(cx, this)], ANIMATION_DIFF_CLAMP, args)
}

/// `a op b`: a node of two operands (nodes or numbers).
fn math(cx: *mut JsContext, op: &str, a: JsValue, b: JsValue) -> JsValue {
    let operand = |v: JsValue| match node_id(cx, v) {
        // The decoder reads a node as its object.
        Some(_) => dup(cx, v),
        None => dup(cx, v),
    };
    let inputs: Vec<JsValue> = [a, b]
        .into_iter()
        .filter(|&v| node_id(cx, v).is_some())
        .map(|v| dup(cx, v))
        .collect();
    let args = vec![string(cx, op), operand(a), operand(b)];
    derived(cx, inputs, ANIMATION_MATH, args)
}

macro_rules! math_method {
    ($name:ident, $op:literal) => {
        unsafe extern "C" fn $name(
            cx: *mut JsContext,
            this: JsValue,
            argc: c_int,
            argv: *mut JsValue,
        ) -> JsValue {
            if let Err(e) = this_node(cx, this) {
                return e;
            }
            math(cx, $op, this, arg(argc, argv, 0))
        }
    };
}

math_method!(node_add, "add");
math_method!(node_sub, "sub");
math_method!(node_mul, "mul");
math_method!(node_div, "div");
math_method!(node_mod, "mod");

/// `new AnimatedValue(value)` / `createAnimatedValue(value)`.
unsafe extern "C" fn animated_value(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut v = 0f64;
    // SAFETY: converting a live value.
    unsafe { qjs::JS_ToFloat64(cx, &mut v, arg(argc, argv, 0)) };
    let (node, id) = new_node(cx, true, Vec::new());
    match send(
        cx,
        vec![int(ANIMATION_VALUE), int(id), qjs::JS_NewFloat64(v)],
    ) {
        Ok(()) => node,
        Err(e) => {
            free(cx, node);
            e
        }
    }
}

/// A new `AnimatedValue` at `value` (owned), for the runtime's own motion
/// (a dialog's popup sliding in).
pub(crate) fn new_value(cx: *mut JsContext, value: f64) -> Result<JsValue, JsValue> {
    let (node, id) = new_node(cx, true, Vec::new());
    match send(
        cx,
        vec![int(ANIMATION_VALUE), int(id), qjs::JS_NewFloat64(value)],
    ) {
        Ok(()) => Ok(node),
        Err(e) => {
            free(cx, node);
            Err(e)
        }
    }
}

/// Runs value `value` to `to` over `ms` with the Bézier `easing`, as its
/// `timing` does; the end's promise is dropped.
pub(crate) fn run_timing(cx: *mut JsContext, value: JsValue, to: f64, ms: f64, easing: [f64; 4]) {
    // SAFETY: new values, owned by the options object and the config.
    let options = unsafe {
        let options = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, options, c"duration".as_ptr(), qjs::JS_NewFloat64(ms));
        let mut points = easing.map(qjs::JS_NewFloat64);
        let curve = qjs::JS_NewArrayFrom(cx, 4, points.as_mut_ptr());
        qjs::JS_SetPropertyStr(cx, options, c"easing".as_ptr(), curve);
        options
    };
    let to = qjs::JS_NewFloat64(to);
    let config = driver_config(cx, "timing", Some(to), options);
    free(cx, options);
    let end = start(cx, value, config);
    free(cx, end);
}

/// `new AnimatedNode()`: a node of its own (a pass-through input).
unsafe extern "C" fn animated_node(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    new_node(cx, false, Vec::new()).0
}

unsafe extern "C" fn value_set(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let id = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let v = dup(cx, arg(argc, argv, 0));
    send(cx, vec![int(ANIMATION_SET), int(id), v])
        .err()
        .unwrap_or(UNDEFINED)
}

unsafe extern "C" fn value_adjust(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let id = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let factor = dup(cx, arg(argc, argv, 0));
    let offset = dup(cx, arg(argc, argv, 1));
    send(cx, vec![int(ANIMATION_ADJUST), int(id), factor, offset])
        .err()
        .unwrap_or(UNDEFINED)
}

/// `stop()`: stops the animation; a promise of where the value stopped.
unsafe extern "C" fn value_stop(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let id = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    if let Err(e) = send(cx, vec![int(ANIMATION_STOP), int(id)]) {
        return e;
    }
    read(cx, id)
}

/// `getValue()`: a promise of the node's current value, read on the UI
/// thread (where it moves).
unsafe extern "C" fn value_get(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    match this_node(cx, this) {
        Ok(id) => read(cx, id),
        Err(e) => e,
    }
}

/// A promise of node `node`'s value, answered by the graph
/// (`AnimationOp::Read`, reported as a `Finished` with the value).
fn read(cx: *mut JsContext, node: u32) -> JsValue {
    let request = next_animation(cx);
    if let Err(e) = send(cx, vec![int(ANIMATION_READ), int(node), int(request)]) {
        return e;
    }
    let (p, resolve) = promise(cx);
    animations(cx).ends.borrow_mut().insert(
        request,
        End {
            resolve,
            callback: UNDEFINED,
            composite: 0,
            read: true,
        },
    );
    p
}

/// A value method sending `code` (and its first argument, with `arg`).
fn value_op(cx: *mut JsContext, this: JsValue, code: i32, arg: Option<JsValue>) -> JsValue {
    let id = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => return e,
    };
    let mut values = vec![int(code), int(id)];
    values.extend(arg.map(|v| dup(cx, v)));
    send(cx, values).err().unwrap_or(UNDEFINED)
}

unsafe extern "C" fn value_set_offset(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    value_op(cx, this, ANIMATION_SET_OFFSET, Some(arg(argc, argv, 0)))
}

unsafe extern "C" fn value_flatten_offset(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    value_op(cx, this, ANIMATION_FLATTEN_OFFSET, None)
}

unsafe extern "C" fn value_extract_offset(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    value_op(cx, this, ANIMATION_EXTRACT_OFFSET, None)
}

/// A new promise and its resolve function (owned).
fn promise(cx: *mut JsContext) -> (JsValue, JsValue) {
    let mut funcs = [UNDEFINED; 2];
    // SAFETY: a new promise; the reject function is not needed.
    unsafe {
        let p = qjs::JS_NewPromiseCapability(cx, funcs.as_mut_ptr());
        qjs::JS_FreeValue(cx, funcs[1]);
        (p, funcs[0])
    }
}

fn next_animation(cx: *mut JsContext) -> u32 {
    let a = animations(cx);
    let id = a.next_animation.get();
    a.next_animation.set(id + 2);
    id
}

/// Starts driver `config` (`{ type, to, ... }`, taken) on value `this`.
fn start(cx: *mut JsContext, this: JsValue, config: JsValue) -> JsValue {
    let node = match this_node(cx, this) {
        Ok(id) => id,
        Err(e) => {
            free(cx, config);
            return e;
        }
    };
    let id = next_animation(cx);
    if let Err(e) = send(cx, vec![int(ANIMATION_START), int(node), int(id), config]) {
        return e;
    }
    let (p, resolve) = promise(cx);
    animations(cx).ends.borrow_mut().insert(
        id,
        End {
            resolve,
            callback: UNDEFINED,
            composite: 0,
            read: false,
        },
    );
    p
}

/// `{ type, to?, ...options }` (a copy of `options`).
fn driver_config(cx: *mut JsContext, kind: &str, to: Option<JsValue>, options: JsValue) -> JsValue {
    let mut args = [options];
    // SAFETY: `merge` copies the options' properties into a new object.
    let config = crate::dom::merge_values(cx, &mut args);
    unsafe {
        qjs::JS_SetPropertyStr(cx, config, c"type".as_ptr(), string(cx, kind));
        if let Some(to) = to {
            qjs::JS_SetPropertyStr(cx, config, c"to".as_ptr(), dup(cx, to));
        }
    }
    config
}

unsafe extern "C" fn value_timing(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let config = driver_config(cx, "timing", Some(arg(argc, argv, 0)), arg(argc, argv, 1));
    start(cx, this, config)
}

unsafe extern "C" fn value_spring(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let config = driver_config(cx, "spring", Some(arg(argc, argv, 0)), arg(argc, argv, 1));
    start(cx, this, config)
}

unsafe extern "C" fn value_decay(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let config = driver_config(cx, "decay", None, arg(argc, argv, 0));
    start(cx, this, config)
}

/// Settles the promise of animation (or value read) `f.animation`
/// (`Host::animations_finished`); false when it is not one of these.
pub(crate) fn finished(
    cx: *mut JsContext,
    f: &nsh_core::animation::Finished,
) -> Result<bool, JsValue> {
    let (id, done) = (f.animation, f.finished);
    let a = animations(cx);
    let Some(End {
        resolve,
        callback,
        composite,
        read,
    }) = a.ends.borrow_mut().remove(&id)
    else {
        return Ok(false);
    };
    if let Some(&p) = a.composites.borrow().get(&composite) {
        // SAFETY: a live composite's data (its finalizer takes it out of
        // the map).
        unsafe {
            if (*p).running == id {
                (*p).running = 0;
            }
        }
    }
    // SAFETY: calls of owned functions.
    unsafe {
        let mut result = Ok(true);
        if qjs::JS_IsFunction(cx, callback) {
            let r = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(
                cx,
                r,
                c"finished".as_ptr(),
                if done { qjs::JS_TRUE } else { qjs::JS_FALSE },
            );
            let mut args = [r];
            let v = qjs::JS_Call(cx, callback, UNDEFINED, 1, args.as_mut_ptr());
            qjs::JS_FreeValue(cx, r);
            if qjs::JS_IsException(v) {
                result = Err(v);
            } else {
                qjs::JS_FreeValue(cx, v);
            }
        }
        let mut args = [match (read, done) {
            (true, _) => qjs::JS_NewFloat64(f.value.unwrap_or(0.0) as f64),
            (false, true) => qjs::JS_TRUE,
            (false, false) => qjs::JS_FALSE,
        }];
        let v = qjs::JS_Call(cx, resolve, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, v);
        for x in [resolve, callback] {
            qjs::JS_FreeValue(cx, x);
        }
        result
    }
}

// --- Composite animations --------------------------------------------------------

/// A composite of `spec` (taken) animating `values` (taken).
fn composite(cx: *mut JsContext, spec: JsValue, values: Vec<JsValue>) -> JsValue {
    let c = classes(cx);
    let a = animations(cx);
    let key = a.next_composite.get();
    a.next_composite.set(key + 2);
    let data = Box::into_raw(Box::new(CompositeData {
        key,
        running: 0,
        spec,
        values,
    }));
    a.composites.borrow_mut().insert(key, data);
    // SAFETY: an object of the composite class owning its data.
    unsafe {
        let obj = qjs::JS_NewObjectClass(cx, c.composite);
        qjs::JS_SetOpaque(obj, data as *mut c_void);
        obj
    }
}

fn composite_data(cx: *mut JsContext, v: JsValue) -> *mut CompositeData {
    let c = classes(cx);
    // SAFETY: the opaque of a composite object.
    unsafe { qjs::JS_GetOpaque(v, c.composite) as *mut CompositeData }
}

unsafe extern "C" fn composite_stop(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let p = composite_data(cx, this);
    // SAFETY: live composite data.
    if p.is_null() || unsafe { (*p).running } == 0 {
        return UNDEFINED;
    }
    let id = unsafe { (*p).running };
    send(cx, vec![int(ANIMATION_STOP_ANIMATION), int(id)])
        .err()
        .unwrap_or(UNDEFINED)
}

unsafe extern "C" fn composite_reset(
    cx: *mut JsContext,
    this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let p = composite_data(cx, this);
    if p.is_null() {
        return UNDEFINED;
    }
    // SAFETY: live composite data.
    let key = unsafe { (*p).key };
    send(cx, vec![int(ANIMATION_RESET_COMPOSITE), int(key)])
        .err()
        .unwrap_or(UNDEFINED)
}

/// `start(callback)`: runs the composite (stopping a run of it first); a
/// promise of whether it finished.
unsafe extern "C" fn composite_start(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let p = composite_data(cx, this);
    if p.is_null() {
        return UNDEFINED;
    }
    // SAFETY: live composite data, reached briefly.
    if unsafe { (*p).running } != 0 {
        let r = unsafe { composite_stop(cx, this, 0, ptr::null_mut()) };
        if unsafe { qjs::JS_IsException(r) } {
            return r;
        }
    }
    let id = next_animation(cx);
    let (key, spec) = unsafe {
        (*p).running = id;
        ((*p).key, qjs::JS_DupValue(cx, (*p).spec))
    };
    if let Err(e) = send(
        cx,
        vec![int(ANIMATION_START_COMPOSITE), int(id), int(key), spec],
    ) {
        return e;
    }
    let (promise, resolve) = promise(cx);
    // Not the composite itself: a run going on must not keep the values it
    // animates alive (an endless loop would run on after its component).
    animations(cx).ends.borrow_mut().insert(
        id,
        End {
            resolve,
            callback: dup(cx, arg(argc, argv, 0)),
            composite: key,
            read: false,
        },
    );
    promise
}

/// The spec and values of composite `v` (dups), if it is one.
fn parts(cx: *mut JsContext, v: JsValue) -> Option<(JsValue, Vec<JsValue>)> {
    let p = composite_data(cx, v);
    // SAFETY: live composite data.
    (!p.is_null()).then(|| unsafe {
        (
            qjs::JS_DupValue(cx, (*p).spec),
            (*p).values
                .iter()
                .map(|&x| qjs::JS_DupValue(cx, x))
                .collect(),
        )
    })
}

fn object(cx: *mut JsContext, fields: Vec<(&CStr, JsValue)>) -> JsValue {
    // SAFETY: a new object taking the values.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        for (k, v) in fields {
            qjs::JS_SetPropertyStr(cx, o, k.as_ptr(), v);
        }
        o
    }
}

/// `numbers` as a JS array.
fn number_array(cx: *mut JsContext, numbers: &[f32]) -> JsValue {
    let mut values: Vec<JsValue> = numbers
        .iter()
        .map(|&x| qjs::JS_NewFloat64(x as f64))
        .collect();
    // SAFETY: the array takes the values.
    unsafe { qjs::JS_NewArrayFrom(cx, values.len() as c_int, values.as_mut_ptr()) }
}

/// `Animated.sampleSpring / sampleDecay(config, fps)`: the values the
/// driver moves through from `config.from` (0), one per frame at `fps`
/// (60) until it ends: what the native driver runs, to draw it.
fn sample(cx: *mut JsContext, kind: &str, config: JsValue, fps: JsValue) -> JsValue {
    let to = get(cx, config, c"toValue");
    let has_to = !unsafe { qjs::JS_IsUndefined(to) };
    let spec = driver_config(cx, kind, has_to.then_some(to), config);
    free(cx, to);
    let (mut from, mut rate) = (0f64, 60f64);
    // SAFETY: conversions of live values.
    unsafe {
        let f = get(cx, config, c"from");
        if !qjs::JS_IsUndefined(f) {
            qjs::JS_ToFloat64(cx, &mut from, f);
        }
        free(cx, f);
        if !qjs::JS_IsUndefined(fps) {
            qjs::JS_ToFloat64(cx, &mut rate, fps);
        }
    }
    // SAFETY: a context reference for the decoder; the value takes `spec`.
    let js_cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(cx)) };
    let spec = unsafe { Value::from_raw(js_cx.clone(), spec) };
    match crate::protocol::driver(&js_cx, &spec) {
        Ok(driver) => {
            let step = 1.0 / rate.clamp(1.0, 1000.0);
            number_array(
                cx,
                &nsh_core::animation::sample_driver(
                    driver,
                    from as f32,
                    step,
                    nsh_core::animation::MAX_SAMPLES,
                ),
            )
        }
        Err(_) => qjs::JS_EXCEPTION,
    }
}

unsafe extern "C" fn animated_sample_spring(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    sample(cx, "spring", arg(argc, argv, 0), arg(argc, argv, 1))
}

unsafe extern "C" fn animated_sample_decay(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    sample(cx, "decay", arg(argc, argv, 0), arg(argc, argv, 1))
}

/// `Easing.sample(easing, count)`: the curve at `count` points of 0..1.
unsafe extern "C" fn easing_sample(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut count = 0f64;
    // SAFETY: a conversion; a context reference for the decoder, which
    // takes a dup.
    unsafe { qjs::JS_ToFloat64(cx, &mut count, arg(argc, argv, 1)) };
    let js_cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(cx)) };
    let e = unsafe { Value::from_raw(js_cx, qjs::JS_DupValue(cx, arg(argc, argv, 0))) };
    let count = if count.is_finite() {
        (count.max(0.0) as usize).min(nsh_core::animation::MAX_SAMPLES)
    } else {
        0
    };
    number_array(
        cx,
        &nsh_core::animation::sample_easing(crate::protocol::easing(e), count),
    )
}

/// `Animated.timing / spring / decay(value, config)`: one driver as a
/// composite.
fn run_driver(cx: *mut JsContext, kind: &str, value: JsValue, config: JsValue) -> JsValue {
    let Some(node) = node_id(cx, value) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"not an animated value".as_ptr()) };
    };
    let to = get(cx, config, c"toValue");
    let has_to = !unsafe { qjs::JS_IsUndefined(to) };
    let spec = driver_config(cx, kind, has_to.then_some(to), config);
    free(cx, to);
    // SAFETY: the spec takes the fields.
    unsafe {
        let atom = qjs::JS_NewAtom(cx, c"toValue".as_ptr());
        qjs::JS_DeleteProperty(cx, spec, atom, 0);
        qjs::JS_FreeAtom(cx, atom);
        qjs::JS_SetPropertyStr(cx, spec, c"node".as_ptr(), int(node));
    }
    composite(cx, spec, vec![dup(cx, value)])
}

macro_rules! driver_fn {
    ($name:ident, $kind:literal) => {
        unsafe extern "C" fn $name(
            cx: *mut JsContext,
            _this: JsValue,
            argc: c_int,
            argv: *mut JsValue,
        ) -> JsValue {
            run_driver(cx, $kind, arg(argc, argv, 0), arg(argc, argv, 1))
        }
    };
}

driver_fn!(animated_timing, "timing");
driver_fn!(animated_spring, "spring");
driver_fn!(animated_decay, "decay");

/// A composite of `kind` over the composites of array `list`, with extra
/// fields.
fn group(cx: *mut JsContext, kind: &str, list: JsValue, extra: Vec<(&CStr, JsValue)>) -> JsValue {
    let mut specs = Vec::new();
    let mut values = Vec::new();
    let mut len: i64 = 0;
    // SAFETY: reads of a live array; values got are freed.
    unsafe {
        if qjs::JS_IsArray(list) && qjs::JS_GetLength(cx, list, &mut len) == 0 {
            for i in 0..len.max(0) {
                let c = qjs::JS_GetPropertyInt64(cx, list, i);
                if let Some((spec, v)) = parts(cx, c) {
                    specs.push(spec);
                    values.extend(v);
                }
                qjs::JS_FreeValue(cx, c);
            }
        }
    }
    let children = unsafe { qjs::JS_NewArrayFrom(cx, specs.len() as c_int, specs.as_mut_ptr()) };
    let mut fields = vec![(c"type", string(cx, kind)), (c"children", children)];
    fields.extend(extra);
    composite(cx, object(cx, fields), values)
}

unsafe extern "C" fn animated_sequence(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    group(cx, "sequence", arg(argc, argv, 0), Vec::new())
}

unsafe extern "C" fn animated_parallel(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let together = get(cx, arg(argc, argv, 1), c"stopTogether");
    let together = if unsafe { qjs::JS_IsUndefined(together) } {
        qjs::JS_TRUE
    } else {
        together
    };
    group(
        cx,
        "parallel",
        arg(argc, argv, 0),
        vec![(c"stopTogether", together)],
    )
}

unsafe extern "C" fn animated_delay(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let spec = object(
        cx,
        vec![
            (c"type", string(cx, "delay")),
            (c"ms", dup(cx, arg(argc, argv, 0))),
        ],
    );
    composite(cx, spec, Vec::new())
}

/// `stagger(ms, list, { from })`: the animations starting `ms` apart,
/// counted from the first (by default), the last, the center or an index.
unsafe extern "C" fn animated_stagger(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut ms = 0f64;
    // SAFETY: a conversion, reads of a live array; values are freed.
    unsafe { qjs::JS_ToFloat64(cx, &mut ms, arg(argc, argv, 0)) };
    let list = arg(argc, argv, 1);
    let from = stagger_from(cx, arg(argc, argv, 2));
    let mut len: i64 = 0;
    let mut staged = Vec::new();
    unsafe {
        if qjs::JS_IsArray(list) && qjs::JS_GetLength(cx, list, &mut len) == 0 {
            let count = len.max(0) as usize;
            for i in 0..count {
                let a = qjs::JS_GetPropertyInt64(cx, list, i as i64);
                let steps = nsh_core::animation::stagger_delay(i, count, from) as f64;
                let mut delay_args = [qjs::JS_NewFloat64(ms * steps)];
                let delay = animated_delay(cx, UNDEFINED, 1, delay_args.as_mut_ptr());
                let mut pair = [delay, a];
                let seq_list = qjs::JS_NewArrayFrom(cx, 2, pair.as_mut_ptr());
                staged.push(group(cx, "sequence", seq_list, Vec::new()));
                qjs::JS_FreeValue(cx, seq_list);
            }
        }
    }
    let all = unsafe { qjs::JS_NewArrayFrom(cx, staged.len() as c_int, staged.as_mut_ptr()) };
    let r = group(cx, "parallel", all, vec![(c"stopTogether", qjs::JS_TRUE)]);
    free(cx, all);
    r
}

/// `{ from }` of a stagger: `"first"`, `"last"`, `"center"` or an index.
fn stagger_from(cx: *mut JsContext, config: JsValue) -> nsh_core::animation::StaggerFrom {
    use nsh_core::animation::StaggerFrom;
    let from = get(cx, config, c"from");
    let mut index = 0f64;
    // SAFETY: checks and a conversion of a live value.
    let r = unsafe {
        if qjs::JS_IsNumber(from) && qjs::JS_ToFloat64(cx, &mut index, from) == 0 {
            StaggerFrom::Index(index.max(0.0) as usize)
        } else {
            match dom::string_arg(cx, from).as_deref() {
                Some("last") => StaggerFrom::Last,
                Some("center") => StaggerFrom::Center,
                _ => StaggerFrom::First,
            }
        }
    };
    free(cx, from);
    r
}

// --- Keyframes and motions ---------------------------------------------------------

/// A keyframes composite on value `value`: `config` is `{ keyframes,
/// duration, delay, easing, iterations, direction }` (copied).
fn keyframes(cx: *mut JsContext, value: JsValue, config: JsValue) -> JsValue {
    let Some(node) = node_id(cx, value) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"not an animated value".as_ptr()) };
    };
    let spec = driver_config(cx, "keyframes", None, config);
    // SAFETY: the spec takes the field.
    unsafe { qjs::JS_SetPropertyStr(cx, spec, c"node".as_ptr(), int(node)) };
    composite(cx, spec, vec![dup(cx, value)])
}

/// `Animated.keyframes(value, config)`.
unsafe extern "C" fn animated_keyframes(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    keyframes(cx, arg(argc, argv, 0), arg(argc, argv, 1))
}

/// Starts composite `c` (taken): a promise of whether it finished.
fn start_composite(cx: *mut JsContext, c: JsValue) -> JsValue {
    // SAFETY: a check of a live value, then its method.
    if unsafe { qjs::JS_IsException(c) } {
        return c;
    }
    let p = unsafe { composite_start(cx, c, 0, ptr::null_mut()) };
    free(cx, c);
    p
}

/// `value.keyframes(keyframes, options)`: plays them on the value; a
/// promise of whether they finished.
unsafe extern "C" fn value_keyframes(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let config = driver_config(cx, "keyframes", None, arg(argc, argv, 1));
    // SAFETY: the config takes the field.
    unsafe {
        qjs::JS_SetPropertyStr(
            cx,
            config,
            c"keyframes".as_ptr(),
            dup(cx, arg(argc, argv, 0)),
        );
    }
    let c = keyframes(cx, this, config);
    free(cx, config);
    start_composite(cx, c)
}

/// Whether field `key` of `obj` is truthy.
fn flag(cx: *mut JsContext, obj: JsValue, key: &CStr) -> bool {
    let v = get(cx, obj, key);
    // SAFETY: a conversion of an owned value, freed.
    let on = unsafe { qjs::JS_ToBool(cx, v) } == 1;
    free(cx, v);
    on
}

/// Motion `motion` (a name or a spec) with `options` (its timing, ...)
/// over it, owned: a preset named with options is the preset's data
/// (`motions`) with them.
fn motion_with(cx: *mut JsContext, motion: JsValue, options: JsValue) -> JsValue {
    // SAFETY: checks of live values; new values owned.
    unsafe {
        if !qjs::JS_IsObject(options) {
            return dup(cx, motion);
        }
        let name = qjs::JS_IsString(motion)
            .then(|| dom::string_arg(cx, motion))
            .flatten();
        let base = match name {
            Some(name) => {
                let motions = table(cx, "motions");
                let name = CString::new(name).unwrap_or_default();
                let preset = qjs::JS_GetPropertyStr(cx, motions, name.as_ptr());
                free(cx, motions);
                if qjs::JS_IsUndefined(preset) {
                    return dup(cx, motion);
                }
                preset
            }
            None => dup(cx, motion),
        };
        let mut args = [base, options];
        let merged = dom::merge_values(cx, &mut args);
        free(cx, base);
        merged
    }
}

/// A composite of `motion` (with `options`) on the channels of motion
/// object `object`, not started.
fn motion_composite(
    cx: *mut JsContext,
    object: JsValue,
    motion: JsValue,
    options: JsValue,
) -> JsValue {
    let mut ids = Vec::with_capacity(MotionChannel::ALL.len());
    let mut values = Vec::with_capacity(MotionChannel::ALL.len());
    for channel in MotionChannel::ALL {
        let name = CString::new(channel.name()).unwrap_or_default();
        let v = get(cx, object, &name);
        ids.push(node_id(cx, v).unwrap_or(0) as f32);
        values.push(v);
    }
    // Less motion, asked for by the user: it lands where it ends.
    let reduced = crate::env::current(cx).reduce_motion
        && !flag(cx, options, c"ignoreReduceMotion")
        && !flag(cx, motion, c"ignoreReduceMotion");
    let spec = object_spec(cx, motion, options, &ids, reduced);
    composite(cx, spec, values)
}

/// Plays `motion` (with `options`) on the channels of motion object
/// `object`: a promise of whether it finished.
fn play(cx: *mut JsContext, object: JsValue, motion: JsValue, options: JsValue) -> JsValue {
    start_composite(cx, motion_composite(cx, object, motion, options))
}

/// The composite spec of a motion's `play`.
fn object_spec(
    cx: *mut JsContext,
    motion: JsValue,
    options: JsValue,
    ids: &[f32],
    reduced: bool,
) -> JsValue {
    object(
        cx,
        vec![
            (c"type", string(cx, "motion")),
            (c"nodes", number_array(cx, ids)),
            (c"motion", motion_with(cx, motion, options)),
            (
                c"reduced",
                if reduced { qjs::JS_TRUE } else { qjs::JS_FALSE },
            ),
        ],
    )
}

/// A motion object's method: `magic` 0 `play`, 1 `stop`, 2 `reset`, 3
/// `animation`; its data is the object.
unsafe extern "C" fn motion_method(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value: the motion object.
    let object = unsafe { *data };
    match magic {
        0 => return play(cx, object, arg(argc, argv, 0), arg(argc, argv, 1)),
        3 => return motion_composite(cx, object, arg(argc, argv, 0), arg(argc, argv, 1)),
        _ => {}
    }
    for channel in MotionChannel::ALL {
        let name = CString::new(channel.name()).unwrap_or_default();
        let v = get(cx, object, &name);
        let id = node_id(cx, v);
        free(cx, v);
        let Some(id) = id else { continue };
        let mut op = vec![int(ANIMATION_STOP), int(id)];
        if magic == 2 {
            op = vec![int(ANIMATION_SET), int(id), int(channel.identity())];
        }
        if let Err(e) = send(cx, op) {
            return e;
        }
    }
    UNDEFINED
}

/// A motion's transform steps (owned) over its channels' `values`: the
/// translations and rotations, then the scales with `scale` folded into
/// `scaleX` and `scaleY` (multiplied natively), so a motion takes 7 of a
/// view's 8 transform steps and leaves one for the app (a `perspective`).
fn motion_transform(cx: *mut JsContext, values: &[JsValue]) -> Vec<JsValue> {
    use MotionChannel::*;
    let at = |c: MotionChannel| values[c.index()];
    let mut steps = Vec::with_capacity(7);
    for channel in [TranslateX, TranslateY, Rotate, RotateX, RotateY] {
        let name = CString::new(channel.name()).unwrap_or_default();
        steps.push(object(cx, vec![(name.as_c_str(), dup(cx, at(channel)))]));
    }
    steps.push(object(
        cx,
        vec![(c"scaleX", math(cx, "mul", at(Scale), at(ScaleX)))],
    ));
    steps.push(object(
        cx,
        vec![(c"scaleY", math(cx, "mul", at(Scale), at(ScaleY)))],
    ));
    steps
}

/// `createMotion(options)`: an animated value per channel at rest (or at
/// `options.initial`, or where `options.enter` starts), their style
/// bindings, and `play` / `stop` / `reset` / `animation`; `enter` plays at
/// once, with the options as its timing.
unsafe extern "C" fn create_motion(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let options = arg(argc, argv, 0);
    let enter = get(cx, options, c"enter");
    let has_enter = !unsafe { qjs::JS_IsUndefined(enter) };
    let mut initial = [None; 9];
    let given = get(cx, options, c"initial");
    for channel in MotionChannel::ALL {
        let name = CString::new(channel.name()).unwrap_or_default();
        let v = get(cx, given, &name);
        let mut x = 0f64;
        // SAFETY: a check and a conversion of an owned value, freed.
        if unsafe { qjs::JS_IsNumber(v) && qjs::JS_ToFloat64(cx, &mut x, v) == 0 } {
            initial[channel.index()] = Some(x as f32);
        }
        free(cx, v);
    }
    free(cx, given);
    let starts = if has_enter {
        // SAFETY: a context reference for the decoder, which takes a dup.
        let js_cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(cx)) };
        let value = unsafe { Value::from_raw(js_cx, dup(cx, enter)) };
        crate::protocol::motion_start(value)
    } else {
        [None; 9]
    };
    // SAFETY: new objects taking the values set on them.
    unsafe {
        let m = qjs::JS_NewObject(cx);
        // The channels' values (owned), by `MotionChannel::ALL`.
        let mut values = Vec::with_capacity(MotionChannel::ALL.len());
        for channel in MotionChannel::ALL {
            let start = starts[channel.index()]
                .or(initial[channel.index()])
                .unwrap_or(channel.identity());
            let v = match new_value(cx, start as f64) {
                Ok(v) => v,
                Err(e) => {
                    free(cx, m);
                    for v in values {
                        free(cx, v);
                    }
                    free(cx, enter);
                    return e;
                }
            };
            let name = CString::new(channel.name()).unwrap_or_default();
            qjs::JS_SetPropertyStr(cx, m, name.as_ptr(), dup(cx, v));
            values.push(v);
        }
        let opacity = dup(cx, values[MotionChannel::Opacity.index()]);
        let transform = motion_transform(cx, &values);
        for v in values {
            free(cx, v);
        }
        let list = |items: &[JsValue]| {
            let mut items: Vec<JsValue> = items.iter().map(|&t| dup(cx, t)).collect();
            qjs::JS_NewArrayFrom(cx, items.len() as c_int, items.as_mut_ptr())
        };
        let style = object(
            cx,
            vec![(c"opacity", opacity), (c"transform", list(&transform))],
        );
        qjs::JS_SetPropertyStr(cx, m, c"transform".as_ptr(), list(&transform));
        qjs::JS_SetPropertyStr(cx, m, c"style".as_ptr(), style);
        for t in transform {
            free(cx, t);
        }
        for (name, magic, length) in [
            (c"play", 0, 2),
            (c"stop", 1, 0),
            (c"reset", 2, 0),
            (c"animation", 3, 2),
        ] {
            let mut data = [m];
            let f = qjs::JS_NewCFunctionData(
                cx,
                Some(motion_method),
                length,
                magic,
                1,
                data.as_mut_ptr(),
            );
            qjs::JS_SetPropertyStr(cx, m, name.as_ptr(), f);
        }
        if has_enter {
            let p = play(cx, m, enter, options);
            free(cx, enter);
            if qjs::JS_IsException(p) {
                free(cx, m);
                return p;
            }
            free(cx, p);
        }
        m
    }
}

/// `motions`: the presets as data.
fn motions(cx: *mut JsContext) -> JsValue {
    table(cx, "motions")
}

/// `loop(animation, { iterations, resetBeforeIteration })`.
unsafe extern "C" fn animated_loop(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some((spec, values)) = parts(cx, arg(argc, argv, 0)) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"loop: an animation".as_ptr()) };
    };
    let config = arg(argc, argv, 1);
    let iterations = get(cx, config, c"iterations");
    let iterations = if unsafe { qjs::JS_IsUndefined(iterations) } {
        qjs::JS_NewFloat64(-1.0)
    } else {
        iterations
    };
    let reset = get(cx, config, c"resetBeforeIteration");
    let reset = if unsafe { qjs::JS_IsUndefined(reset) } {
        qjs::JS_TRUE
    } else {
        reset
    };
    let spec = object(
        cx,
        vec![
            (c"type", string(cx, "loop")),
            (c"child", spec),
            (c"iterations", iterations),
            (c"reset", reset),
        ],
    );
    composite(cx, spec, values)
}

macro_rules! math_fn {
    ($name:ident, $op:literal) => {
        unsafe extern "C" fn $name(
            cx: *mut JsContext,
            _this: JsValue,
            argc: c_int,
            argv: *mut JsValue,
        ) -> JsValue {
            let a = arg(argc, argv, 0);
            if node_id(cx, a).is_none() {
                // SAFETY: throws on a live context.
                return unsafe { qjs::JS_ThrowTypeError(cx, c"not an animated node".as_ptr()) };
            }
            math(cx, $op, a, arg(argc, argv, 1))
        }
    };
}

math_fn!(animated_add, "add");
math_fn!(animated_subtract, "sub");
math_fn!(animated_multiply, "mul");
math_fn!(animated_divide, "div");
math_fn!(animated_modulo, "mod");

unsafe extern "C" fn animated_diff_clamp(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let a = arg(argc, argv, 0);
    // SAFETY: the node method with `a` as `this`.
    unsafe { node_diff_clamp(cx, a, argc - 1, argv.add(1)) }
}

fn functions(cx: *mut JsContext, list: &[(&CStr, Native, c_int)]) -> JsValue {
    // SAFETY: a new object taking the functions.
    let o = unsafe { qjs::JS_NewObject(cx) };
    for &(name, f, length) in list {
        let func = reactive::new_function(cx, name, f, length);
        unsafe { qjs::JS_SetPropertyStr(cx, o, name.as_ptr(), func) };
    }
    o
}

fn animated(cx: *mut JsContext) -> JsValue {
    functions(
        cx,
        &[
            (c"timing", animated_timing, 2),
            (c"spring", animated_spring, 2),
            (c"decay", animated_decay, 2),
            (c"sequence", animated_sequence, 1),
            (c"parallel", animated_parallel, 2),
            (c"stagger", animated_stagger, 3),
            (c"delay", animated_delay, 1),
            (c"loop", animated_loop, 2),
            (c"keyframes", animated_keyframes, 2),
            (c"add", animated_add, 2),
            (c"subtract", animated_subtract, 2),
            (c"multiply", animated_multiply, 2),
            (c"divide", animated_divide, 2),
            (c"modulo", animated_modulo, 2),
            (c"diffClamp", animated_diff_clamp, 3),
            (c"sampleSpring", animated_sample_spring, 2),
            (c"sampleDecay", animated_sample_decay, 2),
        ],
    )
}

/// A constructor-or-function `name` whose objects have `proto`.
fn class_function(cx: *mut JsContext, name: &CStr, f: Native, proto_index: usize) -> JsValue {
    classes(cx);
    let proto = animations(cx).protos.get()[proto_index];
    // SAFETY: a C function callable with or without `new`; its `prototype`
    // is the objects' (so `instanceof` works).
    unsafe {
        let func = qjs::JS_NewCFunction2(
            cx,
            Some(f),
            name.as_ptr(),
            1,
            qjs::JSCFunctionEnum_JS_CFUNC_constructor_or_func,
            0,
        );
        qjs::JS_SetConstructor(cx, func, proto);
        func
    }
}

// --- Easing and LayoutAnimation ------------------------------------------------------

/// The core's animation tables as JS (cached JSON, converted on use).
fn table(cx: *mut JsContext, key: &str) -> JsValue {
    static TABLES: std::sync::OnceLock<nsh_core::JsonValue> = std::sync::OnceLock::new();
    let tables = TABLES.get_or_init(nsh_core::js::animation::tables);
    crate::host::json_to_js(cx, &tables[key])
}

unsafe extern "C" fn easing_curve(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the curve's name and its default parameter.
    let (name, default) = unsafe { (*data, *data.add(1)) };
    let p = arg(argc, argv, 0);
    let param = if unsafe { qjs::JS_IsUndefined(p) } {
        dup(cx, default)
    } else {
        dup(cx, p)
    };
    object(
        cx,
        vec![
            (c"curve", dup(cx, name)),
            (c"param", param),
            (c"mode", string(cx, "in")),
        ],
    )
}

/// `Easing.in / out / inOut(e)`: a curve in that mode (`out` also turns a
/// Bézier or the named in/out easings around).
unsafe extern "C" fn easing_mode(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let e = arg(argc, argv, 0);
    let mode = match magic {
        0 => "in",
        1 => "out",
        _ => "inOut",
    };
    // SAFETY: inline checks and reads of a live value.
    unsafe {
        if qjs::JS_IsArray(e) && magic == 1 {
            let n = |i| {
                let v = qjs::JS_GetPropertyInt64(cx, e, i);
                let mut x = 0f64;
                qjs::JS_ToFloat64(cx, &mut x, v);
                qjs::JS_FreeValue(cx, v);
                x
            };
            let mut values = [
                qjs::JS_NewFloat64(1.0 - n(2)),
                qjs::JS_NewFloat64(1.0 - n(3)),
                qjs::JS_NewFloat64(1.0 - n(0)),
                qjs::JS_NewFloat64(1.0 - n(1)),
            ];
            return qjs::JS_NewArrayFrom(cx, 4, values.as_mut_ptr());
        }
        if qjs::JS_IsObject(e) && !qjs::JS_IsArray(e) {
            let mut args = [e];
            let copy = crate::dom::merge_values(cx, &mut args);
            qjs::JS_SetPropertyStr(cx, copy, c"mode".as_ptr(), string(cx, mode));
            return copy;
        }
        if magic == 1 {
            match dom::string_arg(cx, e).as_deref() {
                Some("easeIn") => return string(cx, "easeOut"),
                Some("easeOut") => return string(cx, "easeIn"),
                _ => {}
            }
        }
        qjs::JS_DupValue(cx, e)
    }
}

/// `Easing.steps(count, position)`: CSS `steps()`.
unsafe extern "C" fn easing_steps(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let position = arg(argc, argv, 1);
    let mut fields = vec![(c"steps", dup(cx, arg(argc, argv, 0)))];
    // SAFETY: a check of a live value.
    if !unsafe { qjs::JS_IsUndefined(position) } {
        fields.push((c"position", dup(cx, position)));
    }
    object(cx, fields)
}

unsafe extern "C" fn easing_bezier(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut values: Vec<JsValue> = (0..4).map(|i| dup(cx, arg(argc, argv, i))).collect();
    // SAFETY: the array takes the values.
    unsafe { qjs::JS_NewArrayFrom(cx, 4, values.as_mut_ptr()) }
}

fn easing(cx: *mut JsContext) -> JsValue {
    // SAFETY: a new object taking its fields.
    let o = unsafe { qjs::JS_NewObject(cx) };
    let curves = table(cx, "curves");
    let mut len: i64 = 0;
    // SAFETY: reads of the table's arrays; values got are freed or moved.
    unsafe {
        qjs::JS_GetLength(cx, curves, &mut len);
        for i in 0..len.max(0) {
            let c = qjs::JS_GetPropertyInt64(cx, curves, i);
            let name = qjs::JS_GetPropertyInt64(cx, c, 0);
            let param = qjs::JS_GetPropertyInt64(cx, c, 1);
            let default = qjs::JS_GetPropertyInt64(cx, c, 2);
            let key =
                CString::new(dom::string_arg(cx, name).unwrap_or_default()).unwrap_or_default();
            let value = if qjs::JS_IsNull(param) {
                object(
                    cx,
                    vec![
                        (c"curve", qjs::JS_DupValue(cx, name)),
                        (c"mode", string(cx, "in")),
                    ],
                )
            } else {
                let mut data = [name, default];
                qjs::JS_NewCFunctionData(cx, Some(easing_curve), 1, 0, 2, data.as_mut_ptr())
            };
            qjs::JS_SetPropertyStr(cx, o, key.as_ptr(), value);
            for v in [c, name, param, default] {
                qjs::JS_FreeValue(cx, v);
            }
        }
        qjs::JS_FreeValue(cx, curves);
        qjs::JS_SetPropertyStr(cx, o, c"linear".as_ptr(), string(cx, "linear"));
        qjs::JS_SetPropertyStr(cx, o, c"ease".as_ptr(), string(cx, "ease"));
        qjs::JS_SetPropertyStr(
            cx,
            o,
            c"bezier".as_ptr(),
            reactive::new_function(cx, c"bezier", easing_bezier, 4),
        );
        qjs::JS_SetPropertyStr(
            cx,
            o,
            c"steps".as_ptr(),
            reactive::new_function(cx, c"steps", easing_steps, 2),
        );
        qjs::JS_SetPropertyStr(
            cx,
            o,
            c"sample".as_ptr(),
            reactive::new_function(cx, c"sample", easing_sample, 2),
        );
        for (name, magic) in [(c"in", 0), (c"out", 1), (c"inOut", 2)] {
            let f = qjs::JS_NewCFunctionData(cx, Some(easing_mode), 1, magic, 0, ptr::null_mut());
            qjs::JS_SetPropertyStr(cx, o, name.as_ptr(), f);
        }
    }
    o
}

/// `LayoutAnimation.configureNext(config, onEnd)`: the next commit's
/// changes animate.
unsafe extern "C" fn configure_next(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let config = arg(argc, argv, 0);
    // SAFETY: a context reference for the decoder, which takes a dup.
    let js_cx = unsafe { Ctx::from_raw(ptr::NonNull::new_unchecked(cx)) };
    let value = unsafe { Value::from_raw(js_cx, qjs::JS_DupValue(cx, config)) };
    match crate::protocol::decode_command("layoutAnimation", value) {
        Ok(Some(command)) => {
            if let Err(e) = dom::push_op(cx, nsh_core::Op::Command { id: 1, command }) {
                return e;
            }
        }
        Ok(None) => {}
        Err(_) => return qjs::JS_EXCEPTION,
    }
    let on_end = arg(argc, argv, 1);
    // SAFETY: an inline check; `setTimeout(onEnd, duration)`.
    unsafe {
        if qjs::JS_IsFunction(cx, on_end) {
            let global = qjs::JS_GetGlobalObject(cx);
            let set_timeout = qjs::JS_GetPropertyStr(cx, global, c"setTimeout".as_ptr());
            let mut args = [on_end, get(cx, config, c"duration")];
            let r = qjs::JS_Call(cx, set_timeout, UNDEFINED, 2, args.as_mut_ptr());
            for v in [r, args[1], set_timeout, global] {
                qjs::JS_FreeValue(cx, v);
            }
        }
    }
    UNDEFINED
}

/// `LayoutAnimation.create(duration, type, property)`.
unsafe extern "C" fn layout_create(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let or = |i: usize, default: &str| {
        let v = arg(argc, argv, i);
        if unsafe { qjs::JS_IsUndefined(v) } {
            string(cx, default)
        } else {
            dup(cx, v)
        }
    };
    let (kind, property) = (or(1, "easeInEaseOut"), or(2, "opacity"));
    let phase = |with_property: bool| {
        let mut fields = vec![(c"type", dup(cx, kind))];
        if with_property {
            fields.push((c"property", dup(cx, property)));
        }
        object(cx, fields)
    };
    let o = object(
        cx,
        vec![
            (c"duration", dup(cx, arg(argc, argv, 0))),
            (c"create", phase(true)),
            (c"update", phase(false)),
            (c"delete", phase(true)),
        ],
    );
    free(cx, kind);
    free(cx, property);
    o
}

/// `LayoutAnimation.easeInEaseOut / linear / spring(onEnd)`: a preset.
unsafe extern "C" fn layout_preset(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    _data: *mut JsValue,
) -> JsValue {
    let presets = table(cx, "presets");
    let name = match magic {
        0 => c"easeInEaseOut",
        1 => c"linear",
        _ => c"spring",
    };
    let preset = get(cx, presets, name);
    let mut args = [preset, arg(argc, argv, 0)];
    // SAFETY: borrowed arguments.
    let r = unsafe { configure_next(cx, UNDEFINED, 2, args.as_mut_ptr()) };
    free(cx, preset);
    free(cx, presets);
    r
}

/// An object naming each of `names` as itself.
fn names_object(cx: *mut JsContext, names: JsValue) -> JsValue {
    // SAFETY: a new object; reads of a live array, values freed or moved.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        let mut len: i64 = 0;
        qjs::JS_GetLength(cx, names, &mut len);
        for i in 0..len.max(0) {
            let n = qjs::JS_GetPropertyInt64(cx, names, i);
            let key = CString::new(dom::string_arg(cx, n).unwrap_or_default()).unwrap_or_default();
            qjs::JS_SetPropertyStr(cx, o, key.as_ptr(), n);
        }
        qjs::JS_FreeValue(cx, names);
        o
    }
}

fn layout_animation(cx: *mut JsContext) -> JsValue {
    let o = functions(
        cx,
        &[
            (c"configureNext", configure_next, 2),
            (c"create", layout_create, 3),
        ],
    );
    // SAFETY: the object takes its fields.
    unsafe {
        qjs::JS_SetPropertyStr(
            cx,
            o,
            c"Types".as_ptr(),
            names_object(cx, table(cx, "types")),
        );
        qjs::JS_SetPropertyStr(
            cx,
            o,
            c"Properties".as_ptr(),
            names_object(cx, table(cx, "properties")),
        );
        qjs::JS_SetPropertyStr(cx, o, c"Presets".as_ptr(), table(cx, "presets"));
        for (name, magic) in [(c"easeInEaseOut", 0), (c"linear", 1), (c"spring", 2)] {
            let f = qjs::JS_NewCFunctionData(cx, Some(layout_preset), 1, magic, 0, ptr::null_mut());
            qjs::JS_SetPropertyStr(cx, o, name.as_ptr(), f);
        }
    }
    o
}

/// `nsh/animated`.
pub(crate) const EXPORTS: &[Item] = &[
    (
        "AnimatedNode",
        Export::Value(|cx| class_function(cx, c"AnimatedNode", animated_node, 0)),
        Ts::class(
            "A node of the native animation graph: evaluated on the UI thread.",
            r#" {
  #private;
  constructor(inputs?: AnimatedNode[]);
  /** Maps this node through piecewise ranges: numbers, colors or angles
   * (`"45deg"`, `"1rad"`). Outside the input range it clamps by default;
   * `easing` shapes each segment. */
  interpolate(config: {
    inputRange: number[];
    outputRange: number[] | string[];
    extrapolate?: Extrapolation;
    extrapolateLeft?: Extrapolation;
    extrapolateRight?: Extrapolation;
    easing?: Easing;
  }): AnimatedNode;
  /** Follows this node's changes, kept within `min..max` (a header that
   * hides while content scrolls up and comes back as it scrolls down).
   * `snap`: when the scroll view it follows comes to rest between the
   * bounds, it settles at the nearer one in 200 ms, easing out (a floating
   * bar shows or hides fully); at `max` only once this node reached
   * `max`, so a page scrolled less than the bar's height shows all of it. */
  diffClamp(min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  add(b: AnimatedNode | number): AnimatedNode;
  sub(b: AnimatedNode | number): AnimatedNode;
  mul(b: AnimatedNode | number): AnimatedNode;
  div(b: AnimatedNode | number): AnimatedNode;
  /** Modulo, never negative for a positive `b` (e.g. angles in 0..360). */
  mod(b: AnimatedNode | number): AnimatedNode;
}"#,
        ),
    ),
    (
        "AnimatedValue",
        Export::Value(|cx| class_function(cx, c"AnimatedValue", animated_value, 1)),
        Ts::class(
            "A settable, animatable animated value.",
            r#" extends AnimatedNode {
  constructor(value: number);
  /** Jumps to `value`, stopping any animation. */
  set(value: number): void;
  /** Adjusts the base value to value * factor + offset on the UI thread,
   * stopping its animation and retaining the offset from `setOffset`. */
  adjust(factor: number, offset: number): void;
  /** Stops the running animation where it is; resolves with the value
   * there. */
  stop(): Promise<number>;
  /** The current value (with its offset), read where it moves (the UI
   * thread): settles within a frame. */
  getValue(): Promise<number>;
  /** An offset added to the value (React Native's `setOffset`): bindings
   * see value + offset; `set`, animations and drags move the value. */
  setOffset(offset: number): void;
  /** Adds the offset to the value and makes it 0. */
  flattenOffset(): void;
  /** Moves the value into the offset and makes the value 0 (a drag then
   * starts from where the last one left it). */
  extractOffset(): void;
  /** Animates to `to` over `duration` ms. Resolves with `finished`. */
  timing(to: number, options?: { duration?: number; easing?: Easing; delay?: number }): Promise<boolean>;
  /** Springs to `to`. Resolves with `finished`. */
  spring(to: number, options?: { stiffness?: number; damping?: number; mass?: number; velocity?: number }): Promise<boolean>;
  /** Coasts from `velocity` (units per second) and slows down; within
   * `clamp` it stops at a bound, or bounces back keeping `bounce` (0..1) of
   * its speed. */
  decay(options?: DecayConfig): Promise<boolean>;
  /** Plays `keyframes` (numbers spread evenly, or `{ offset, value, easing }`)
   * as CSS keyframes play: each segment with its easing (CSS `ease` by
   * default), `iterations` times in `direction`. Resolves with `finished`. */
  keyframes(keyframes: KeyframeValue[], options?: KeyframeTiming): Promise<boolean>;
}"#,
        ),
    ),
    (
        "createAnimatedValue",
        Export::Function(animated_value, 1),
        Ts::function(
            "Creates an animated value. Bind it (or nodes derived from it) to style\nproperties (`opacity`, `transform`, `backgroundColor`, `borderColor`, a\ntext's `color`, `shadowColor` / `shadowOpacity` / `shadowRadius`), to a\nscroll position (`scrollValue`) or to drags (`pan`).",
            &["(value?: number): AnimatedValue"],
        ),
    ),
    (
        "createMotion",
        Export::Function(create_motion, 1),
        Ts::function(
            "Creates a motion: an animated value for each channel (`opacity`, `translateX`,\n`translateY`, `rotate`, `rotateX`, `rotateY`, `scale`, `scaleX`, `scaleY`) at rest, bound\nwith `style={motion.style}` (or `opacity` and `transform` spread into a style), and\n`play(motion, options)` to run a preset (`\"shake\"`, `\"fadeInUp\"`, ...) or keyframes of\nyour own on them, natively. `enter` starts the values where that motion starts and\nplays it at once (the options also take its timing: `delay`, `duration`, ...). When the\nuser asks for less motion, motions land where they end without moving, unless\n`ignoreReduceMotion` is set.",
            &["(options?: MotionOptions): Motion"],
        ),
    ),
    (
        "motions",
        Export::Value(motions),
        Ts::value(
            "The ready-made motions as data (`motion.play(\"shake\")` plays `motions.shake`):\nentrances, exits, attention seekers and loops. Spread one to change it:\n`motion.play({ ...motions.fadeInUp, duration: 600 })`.",
            "Readonly<Record<MotionName, MotionPreset>>",
        ),
    ),
    (
        "Animated",
        Export::Value(animated),
        Ts::value(
            "Animations composed natively (React Native's `Animated`): each step\nstarts on the UI thread the moment the previous one ends.",
            "AnimatedModule",
        ),
    ),
    (
        "Easing",
        Export::Value(easing),
        Ts::value(
            "Easing functions (React Native's `Easing`): curves in their \"in\" form,\nturned around with `out` / `inOut`.",
            "EasingModule",
        ),
    ),
    (
        "LayoutAnimation",
        Export::Value(layout_animation),
        Ts::value(
            "Animates the layout changes of the next render natively: frames move,\nnew views fade in, removed views fade out.",
            "LayoutAnimationModule",
        ),
    ),
];

/// `nsh/animated`'s types (with the easing and layout animation types of
/// `nsh_core::js::animation::declarations`).
pub(crate) const TYPES: &str = r#"export type Extrapolation = "extend" | "clamp" | "identity";

/** A decay: coasting from `velocity` (units per second, the current one by
 * default), keeping `deceleration` (0.998) of it each millisecond. */
export interface DecayConfig {
  velocity?: number;
  deceleration?: number;
  /** Bounds the value stays within: it stops at a bound, or bounces back
   * from it with `bounce`. */
  clamp?: [min: number, max: number];
  /** The fraction of its speed it keeps bouncing off a bound (0, the
   * default: it stops there). */
  bounce?: number;
}

/** A spring (React Native's `Animated.spring` config). */
export interface SpringConfig {
  toValue: number;
  stiffness?: number;
  damping?: number;
  mass?: number;
  velocity?: number;
}

/** Easing functions (React Native's `Easing`). */
export interface EasingModule extends EasingCurves {
  linear: Easing;
  ease: Easing;
  bezier(x1: number, y1: number, x2: number, y2: number): Easing;
  /** CSS `steps(count, position)`: jumps between `count` levels. */
  steps(count: number, position?: StepPosition): EasingSteps;
  in(e: Easing): Easing;
  out(e: Easing): Easing;
  inOut(e: Easing): Easing;
  /** The curve at `count` evenly spaced points from 0 to 1 (both
   * included), computed by the native implementation the animations run:
   * to draw it. */
  sample(easing: Easing, count: number): number[];
}

/** A keyframe of one value: where it is at `offset` (0..1 of an iteration;
 * missing offsets spread evenly, as in the Web Animations API) and the easing
 * of the segment that starts there. Values are numbers, or angles
 * (`"45deg"`, `"0.5turn"`) in degrees. */
export interface Keyframe {
  offset?: number;
  value: number | string;
  easing?: Easing;
}

/** A keyframe, or only its value (spread evenly with the others). */
export type KeyframeValue = number | string | Keyframe;

/** Which way iterations of keyframes play (CSS `animation-direction`). */
export type PlaybackDirection = "normal" | "reverse" | "alternate" | "alternate-reverse";

/** How keyframes play, as CSS animations do. */
export interface KeyframeTiming {
  /** One iteration, in milliseconds (300). */
  duration?: number;
  /** Before the first iteration, in milliseconds. */
  delay?: number;
  /** The curve of each segment without one of its own (CSS `ease`). */
  easing?: Easing;
  /** How many iterations (1), or `"infinite"`. */
  iterations?: number | "infinite";
  /** Which way they play (`"normal"`). */
  direction?: PlaybackDirection;
}

/** `Animated.keyframes`' config. */
export interface KeyframesConfig extends KeyframeTiming {
  keyframes: KeyframeValue[];
}

/** One frame of several channels, as the Web Animations API writes them:
 * `{ opacity: 0, translateY: 24 }`, with its `offset` and `easing`. */
export type MotionFrame = { [C in MotionChannel]?: number | string } & { offset?: number; easing?: Easing };

/** A motion of your own: each channel's keyframes (`{ opacity: [0, 1],
 * translateY: [24, 0] }`) or a list of frames (`[{ opacity: 0 }, { opacity: 1
 * }]`), with how they play. */
export interface MotionSpec extends KeyframeTiming {
  keyframes: { [C in MotionChannel]?: KeyframeValue[] } | MotionFrame[];
  /** Plays even when the user asks for less motion. */
  ignoreReduceMotion?: boolean;
}

/** A ready-made motion (`motions.<name>`). */
export interface MotionPreset extends MotionSpec {
  /** What it is for: it brings a view in, takes it out, draws the eye or
   * repeats. */
  kind: "enter" | "exit" | "attention" | "loop";
}

/** Options of `play`: the motion's timing changed, and more. */
export interface MotionPlayOptions extends KeyframeTiming {
  /** Plays even when the user asks for less motion. */
  ignoreReduceMotion?: boolean;
}

/** `createMotion`'s options: where channels start, a motion to enter with,
 * and its timing. */
export interface MotionOptions extends MotionPlayOptions {
  /** Where channels start (the others at rest): `{ opacity: 0 }`. */
  initial?: { [C in MotionChannel]?: number };
  /** Starts where this motion starts and plays it at once. */
  enter?: MotionName | MotionSpec;
}

/** A motion's transform: its channels in the order they apply, `scale`
 * folded into `scaleX` and `scaleY` (7 steps; a view takes 8, so one is left
 * for yours, such as a `perspective` before them for 3D flips). */
export type MotionTransform = [
  { translateX: AnimatedValue },
  { translateY: AnimatedValue },
  { rotate: AnimatedValue },
  { rotateX: AnimatedValue },
  { rotateY: AnimatedValue },
  { scaleX: AnimatedNode },
  { scaleY: AnimatedNode },
];

/** Animated values for a view's opacity and transform, and motions to play
 * on them (`createMotion`). */
export interface Motion {
  readonly opacity: AnimatedValue;
  readonly translateX: AnimatedValue;
  readonly translateY: AnimatedValue;
  /** Degrees. */
  readonly rotate: AnimatedValue;
  readonly rotateX: AnimatedValue;
  readonly rotateY: AnimatedValue;
  readonly scale: AnimatedValue;
  readonly scaleX: AnimatedValue;
  readonly scaleY: AnimatedValue;
  /** `{ opacity, transform }`: bind it with `style={motion.style}`, or
   * spread it into a style. */
  readonly style: { opacity: AnimatedValue; transform: MotionTransform };
  /** The transform alone, to spread into one with steps of your own. */
  readonly transform: MotionTransform;
  /** Plays a preset or a motion of your own; a new one interrupts the one
   * playing. Resolves with whether it finished. */
  play(motion: MotionName | MotionSpec, options?: MotionPlayOptions): Promise<boolean>;
  /** The same motion as an animation to compose, not started:
   * `Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from:
   * "center" })`. */
  animation(motion: MotionName | MotionSpec, options?: MotionPlayOptions): CompositeAnimation;
  /** Stops it where it is. */
  stop(): void;
  /** Stops it and puts every channel back at rest. */
  reset(): void;
}

/** An animation built with `Animated`: runs natively, steps and all. */
export interface CompositeAnimation {
  /** Runs it (again). Resolves (and calls `callback`) with whether it
   * finished rather than being stopped. */
  start(callback?: (result: { finished: boolean }) => void): Promise<boolean>;
  /** Stops it where it is. */
  stop(): void;
  /** Stops it and puts its values back where they were when it started. */
  reset(): void;
}

/** Animations composed natively (React Native's `Animated`). */
export interface AnimatedModule {
  timing(value: AnimatedValue, config: { toValue: number; duration?: number; easing?: Easing; delay?: number }): CompositeAnimation;
  spring(value: AnimatedValue, config: SpringConfig): CompositeAnimation;
  decay(value: AnimatedValue, config?: DecayConfig): CompositeAnimation;
  sequence(list: CompositeAnimation[]): CompositeAnimation;
  parallel(list: CompositeAnimation[], config?: { stopTogether?: boolean }): CompositeAnimation;
  /** The animations all at once, each starting `ms` after the one before,
   * counted from the first, the last, the center item or an index. */
  stagger(ms: number, list: CompositeAnimation[], config?: { from?: "first" | "last" | "center" | number }): CompositeAnimation;
  delay(ms: number): CompositeAnimation;
  loop(animation: CompositeAnimation, config?: { iterations?: number; resetBeforeIteration?: boolean }): CompositeAnimation;
  /** `value` through keyframes, as CSS keyframes play (see `KeyframeTiming`). */
  keyframes(value: AnimatedValue, config: KeyframesConfig): CompositeAnimation;
  add(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  subtract(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  multiply(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  divide(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  modulo(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  diffClamp(a: AnimatedNode, min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  /** The values a spring moves through from `from` (0), one per frame at
   * `fps` (60) until it rests: the exact curve the native driver runs. */
  sampleSpring(config: SpringConfig & { from?: number }, fps?: number): number[];
  /** The same for a decay (it starts at `from`, 0 by default). */
  sampleDecay(config: DecayConfig & { from?: number }, fps?: number): number[];
}

/** `LayoutAnimation`. */
export interface LayoutAnimationModule {
  /** Animates the changes of the next commit. `onEnd` runs when done. */
  configureNext(config: LayoutAnimationConfig, onEnd?: () => void): void;
  /** A config with `duration`, the same curve for all three phases. */
  create: (duration: number, type?: LayoutAnimationType, property?: LayoutAnimationProperty) => LayoutAnimationConfig;
  Types: LayoutAnimationTypes;
  Properties: LayoutAnimationProperties;
  Presets: LayoutAnimationPresets;
  easeInEaseOut(onEnd?: () => void): void;
  linear(onEnd?: () => void): void;
  spring(onEnd?: () => void): void;
}
"#;

#[cfg(test)]
mod tests {
    use nsh_core::Op;

    use crate::Host;

    #[test]
    fn animations_settle_their_promises_and_callbacks() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { Animated, AnimatedValue } from "nsh";
            import { text } from "nsh:rt";
            const v = new AnimatedValue(0);
            globalThis.log = [];
            v.timing(1, { duration: 10 }).then((f) => log.push(`timing ${f}`));
            Animated.sequence([Animated.delay(5), Animated.timing(v, { toValue: 0 })])
                .start((r) => log.push(`callback ${r.finished}`))
                .then((f) => log.push(`sequence ${f}`));
            globalThis.report = () => text(log.join("|"));
            globalThis.keep = v;
            "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let starts: Vec<u32> = ops
            .iter()
            .filter_map(|o| match o {
                Op::Animation(nsh_core::animation::AnimationOp::Start { animation, .. }) => {
                    Some(*animation)
                }
                Op::Animation(nsh_core::animation::AnimationOp::StartComposite {
                    animation,
                    ..
                }) => Some(*animation),
                _ => None,
            })
            .collect();
        assert_eq!(starts, [2, 4], "{ops:?}");
        host.animations_finished(&[
            nsh_core::animation::Finished::new(2, true),
            nsh_core::animation::Finished::new(4, false),
        ]);
        host.eval_script("report.js", "report()").unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let log = ops.iter().find_map(|o| match o {
            Op::CreateText { text, .. } => Some(text.clone()),
            _ => None,
        });
        assert_eq!(
            log.as_deref(),
            // Callbacks run at once, promise reactions after (as in the JS
            // runtime).
            Some("callback false|timing true|sequence false")
        );
    }

    fn animation_ops(host: &Host) -> Vec<nsh_core::animation::AnimationOp> {
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.into_iter()
            .filter_map(|o| match o {
                Op::Animation(op) => Some(op),
                _ => None,
            })
            .collect()
    }

    fn report(host: &Host) -> Option<String> {
        host.eval_script("report.js", "report()").unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.iter().find_map(|o| match o {
            Op::CreateText { text, .. } => Some(text.to_string()),
            _ => None,
        })
    }

    #[test]
    fn values_are_read_back_and_offset() {
        use nsh_core::animation::AnimationOp as A;
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { AnimatedValue } from "nsh";
            import { text } from "nsh:rt";
            const v = new AnimatedValue(1);
            globalThis.log = [];
            v.setOffset(5);
            v.extractOffset();
            v.flattenOffset();
            v.adjust(2, -3);
            v.getValue().then((x) => log.push(`value ${x}`));
            v.stop().then((x) => log.push(`stopped ${x}`));
            globalThis.report = () => text(log.join("|"));
            globalThis.keep = v;
            "#,
        )
        .unwrap();
        let ops = animation_ops(&host);
        assert_eq!(
            ops,
            [
                A::CreateValue {
                    node: 2,
                    value: 1.0
                },
                A::SetOffset {
                    node: 2,
                    offset: 5.0
                },
                A::ExtractOffset { node: 2 },
                A::FlattenOffset { node: 2 },
                A::Adjust {
                    node: 2,
                    factor: 2.0,
                    offset: -3.0
                },
                A::Read {
                    node: 2,
                    request: 2
                },
                A::Stop { node: 2 },
                A::Read {
                    node: 2,
                    request: 4
                },
            ]
        );
        host.animations_finished(&[
            nsh_core::animation::Finished {
                animation: 2,
                finished: true,
                value: Some(6.0),
            },
            nsh_core::animation::Finished {
                animation: 4,
                finished: true,
                value: Some(6.5),
            },
        ]);
        assert_eq!(report(&host).as_deref(), Some("value 6|stopped 6.5"));
    }

    #[test]
    fn identical_derived_nodes_are_one_node() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { AnimatedValue } from "nsh";
            import { text } from "nsh:rt";
            const v = new AnimatedValue(0);
            const config = { inputRange: [0, 1], outputRange: ["red", "blue"] };
            // As a canvas drawing again would.
            globalThis.keep = [
                v,
                v.interpolate(config),
                v.interpolate({ ...config }),
                v.interpolate({ inputRange: [0, 1], outputRange: ["red", "green"] }),
                v.mul(2),
                v.mul(2),
                v.mul(-0),
                v.mul(0),
            ];
            globalThis.report = () => {
                const [, a, b, c, d, e, f, g] = keep;
                return text([a === b, a !== c, d === e, f === g, d !== f].join(","));
            };
            "#,
        )
        .unwrap();
        let ops = animation_ops(&host);
        let created = ops
            .iter()
            .filter(|o| {
                matches!(
                    o,
                    nsh_core::animation::AnimationOp::CreateInterpolate { .. }
                        | nsh_core::animation::AnimationOp::CreateMath { .. }
                )
            })
            .count();
        assert_eq!(created, 4, "{ops:?}");
        assert_eq!(report(&host).as_deref(), Some("true,true,true,true,true"));
        // Once collected, deriving it again makes a new node.
        host.eval_script(
            "drop.js",
            "keep = [keep[0]]; globalThis.again = () => keep[0].mul(2);",
        )
        .unwrap();
        host.collect_garbage();
        let released = animation_ops(&host);
        assert!(
            released.contains(&nsh_core::animation::AnimationOp::Release { node: 8 }),
            "{released:?}"
        );
        host.eval_script("again.js", "keep.push(again())").unwrap();
        let ops = animation_ops(&host);
        assert!(
            matches!(ops[..], [nsh_core::animation::AnimationOp::CreateMath { node, .. }] if node > 8),
            "{ops:?}"
        );
    }

    #[test]
    fn an_endless_loop_does_not_keep_its_values() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { Animated, AnimatedValue } from "nsh";
            globalThis.v = new AnimatedValue(0);
            Animated.loop(Animated.timing(v, { toValue: 1 })).start();
            "#,
        )
        .unwrap();
        let ops = animation_ops(&host);
        assert!(
            ops.iter()
                .any(|o| matches!(o, nsh_core::animation::AnimationOp::StartComposite { .. })),
            "{ops:?}"
        );
        // Its component goes: nothing holds the value but the running loop.
        host.eval_script("drop.js", "v = undefined").unwrap();
        host.collect_garbage();
        let ops = animation_ops(&host);
        // The graph stops a loop whose value is released.
        assert!(
            ops.contains(&nsh_core::animation::AnimationOp::Release { node: 2 }),
            "{ops:?}"
        );
    }

    #[test]
    fn a_diff_clamp_asks_to_snap() {
        use nsh_core::animation::AnimationOp as A;
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { Animated, AnimatedValue } from "nsh";
            import { text } from "nsh:rt";
            const scroll = new AnimatedValue(0);
            const plain = scroll.diffClamp(0, 56);
            const snapping = scroll.diffClamp(0, 56, { snap: true });
            globalThis.report = () =>
                text([
                    plain === snapping,
                    Animated.diffClamp(scroll, 0, 56, { snap: true }) === snapping,
                    scroll.diffClamp(0, 56, { snap: false }) === plain,
                ].join(","));
            globalThis.keep = [scroll, plain, snapping];
            "#,
        )
        .unwrap();
        let snaps: Vec<bool> = animation_ops(&host)
            .into_iter()
            .filter_map(|o| match o {
                A::CreateDiffClamp { snap, .. } => Some(snap),
                _ => None,
            })
            .collect();
        assert_eq!(snaps, [false, true]);
        // Equal ones share a node; a snapping one is not a plain one.
        assert_eq!(report(&host).as_deref(), Some("false,true,true"));
    }

    #[test]
    fn curves_are_sampled_natively() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { Animated, Easing } from "nsh";
            import { text } from "nsh:rt";
            const quad = Easing.sample(Easing.quad, 3);
            const spring = Animated.sampleSpring({ toValue: 1, from: 0, damping: 40 });
            const decay = Animated.sampleDecay({ velocity: 1000, clamp: [0, 100] }, 120);
            globalThis.report = () =>
                text([
                    quad.join(" "),
                    spring[0],
                    spring[spring.length - 1],
                    spring.some((x) => x > 1),
                    decay[decay.length - 1],
                    Easing.sample(Easing.linear, 0).length,
                ].join(","));
            "#,
        )
        .unwrap();
        animation_ops(&host);
        assert_eq!(report(&host).as_deref(), Some("0 0.25 1,0,1,false,100,0"));
    }

    #[test]
    fn keyframes_and_motions_become_native_trees() {
        use nsh_core::animation::{AnimationOp as A, Composite, Driver};
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { Animated, AnimatedValue, Easing, createMotion, motions } from "nsh";
            import { text } from "nsh:rt";
            const v = new AnimatedValue(0);
            v.keyframes([0, { value: 10, offset: 0.25, easing: Easing.steps(2) }, 0], { duration: 400 });
            const m = createMotion({ enter: "fadeInUp", delay: 100 });
            m.play({ keyframes: [{ rotate: "0deg" }, { rotate: "0.5turn" }], iterations: "infinite" });
            const staggered = Animated.stagger(10, [0, 1, 2].map(() => Animated.timing(v, { toValue: 1 })), { from: "center" });
            globalThis.report = () =>
                text([
                    Easing.sample(Easing.steps(2), 3).join(" "),
                    motions.shake.kind,
                    motions.fadeInUp.keyframes.translateY[0].value,
                    m.style.transform.length,
                    m.style.opacity === m.opacity,
                    typeof m.play,
                ].join(","));
            globalThis.keep = [v, m, staggered];
            "#,
        )
        .unwrap();
        let ops = animation_ops(&host);
        let composites: Vec<&Composite> = ops
            .iter()
            .filter_map(|o| match o {
                A::StartComposite { spec, .. } => Some(spec),
                _ => None,
            })
            .collect();
        assert_eq!(composites.len(), 3, "{ops:?}");
        // The keyframes: a jump to 0, 0 -> 10 over 100 ms, then back in
        // steps (a keyframe's easing shapes the segment starting there).
        let Composite::Sequence(steps) = composites[0] else {
            panic!("{:?}", composites[0])
        };
        assert!(matches!(
            steps[1],
            Composite::Run {
                driver: Driver::Timing {
                    to: 10.0,
                    duration_ms: 100.0,
                    ..
                },
                ..
            }
        ));
        assert!(matches!(
            steps[2],
            Composite::Run {
                driver: Driver::Timing {
                    to: 0.0,
                    duration_ms: 300.0,
                    easing: nsh_core::animation::Easing::Steps(2, _),
                    ..
                },
                ..
            }
        ));
        // The motion's values start where `fadeInUp` starts.
        let created: Vec<f32> = ops
            .iter()
            .filter_map(|o| match o {
                A::CreateValue { value, .. } => Some(*value),
                _ => None,
            })
            .collect();
        assert_eq!(created, [0.0, 0.0, 0.0, 24.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
        // Its enter: two tracks holding their first keyframe through the
        // delay; the play: one endless track in degrees.
        let Composite::Parallel { children, .. } = composites[1] else {
            panic!("{:?}", composites[1])
        };
        assert_eq!(children.len(), 2);
        assert!(matches!(&children[0], Composite::Sequence(s) if s[1] == Composite::Delay(100.0)));
        let Composite::Parallel { children, .. } = composites[2] else {
            panic!("{:?}", composites[2])
        };
        let Composite::Loop {
            child,
            iterations: None,
            ..
        } = &children[0]
        else {
            panic!("{children:?}")
        };
        assert!(matches!(
            &**child,
            Composite::Sequence(s) if matches!(s[1], Composite::Run { driver: Driver::Timing { to: 180.0, .. }, .. })
        ));
        assert_eq!(
            report(&host).as_deref(),
            Some("0 0.5 1,attention,24,7,true,function")
        );
    }
}
