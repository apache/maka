//! The renderer compiled JSX runs on: the natives of `nsh:rt` (internal:
//! only the bundler's JSX output imports it) and the parts of `nsh` built
//! on them (`context`, `mount`).
//!
//! A node is a JS object of a native class holding its id and what keeps
//! the tree alive: a parent holds its children's objects and a node holds
//! its event handlers, and the GC mark reports both, so the tree, the
//! handlers and whatever they capture are one heap the QuickJS collector
//! sees. The root view (id 1) is held by the renderer. A node nothing
//! refers to any more is collected and its native view released (a removed
//! node may be inserted again while JS holds it).
//!
//! Every change becomes an [`Op`] pushed straight into the host's op
//! queue. Dynamic children are kept by a
//! render effect whose value is the array of nodes it inserted, reconciled
//! with Solid's `reconcileArrays` against the parent's children, which the
//! renderer mirrors.
//!
//! Re-entrancy: freeing a JS value can finalize a node, whose finalizer
//! updates the renderer (`nodes`, the op queue). The renderer is only ever
//! reached by shared reference with short `RefCell` borrows, none held
//! across a call into JS, an allocation of a JS value or a free of one.

use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_int, c_void},
    ptr,
    rc::Rc,
};

use nsh_core::{EventKind, NodeId, Op, Tag, decl, platform::Os};
use rquickjs::{Ctx, Value, qjs};
use rustc_hash::FxHashMap;

use crate::{
    host::Shared,
    modules::{Export, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;
/// No parent.
const DETACHED: NodeId = 0;
/// The surface's root view.
const ROOT: NodeId = 1;
/// How deep nested arrays and accessors are unwrapped.
const MAX_DEPTH: u32 = 64;

/// The renderer's part of a context's state.
pub(crate) struct Dom {
    shared: Rc<Shared>,
    classes: Classes,
    /// The next id JS gives a node (even: the core gives odd ones).
    next_id: Cell<NodeId>,
    /// Live nodes by `id >> 1` (the root is 0); weak: a node's object owns
    /// its data.
    nodes: RefCell<Vec<*mut NodeData>>,
    /// The root view's object (owned).
    root: Cell<JsValue>,
    /// The platform: `ios={{…}}` / `android={{…}}` / `web={{…}}` props
    /// apply on it only.
    os: Cell<Os>,
    /// Desktop behavior applies (`desktop={{…}}`; `Environment::desktop`).
    desktop: Cell<bool>,
    /// The layout direction sent to the root (`None`: nothing mounted yet).
    rtl: Cell<Option<bool>>,
    /// The `onDismiss` handlers of modals the app removed, kept until the
    /// platform reports their dismissal, oldest first (owned): an app
    /// removes a dialog in `onOpenChange` or `onCancel`, and the platform reports
    /// `onDismiss` once it has gone (after its animation).
    dismissed: RefCell<Vec<(NodeId, JsValue)>>,
    /// Whether the user's language is written right to left.
    env_rtl: Cell<bool>,
    /// The tags (bits by `Tag as u32`; 63: the root) text was put in
    /// without being shown, each reported once.
    unshown_text: Cell<u64>,
}

#[derive(Clone, Copy)]
struct Classes {
    node: qjs::JSClassID,
    each: qjs::JSClassID,
    context: qjs::JSClassID,
}

struct NodeData {
    id: NodeId,
    /// A text node.
    text: bool,
    /// An element's tag (`None`: a text node or the root).
    tag: Option<Tag>,
    /// A screen's callback for when the user popped it natively (owned).
    popped: JsValue,
    /// The parent in the mirror ([`DETACHED`]: none).
    parent: NodeId,
    /// The children in order (owned objects).
    children: Vec<JsValue>,
    /// Event handlers (owned).
    handlers: Vec<Handler>,
    /// Touch and responder handlers, by `touch::TOUCH_PROPS` index (owned).
    touch: Vec<(u8, JsValue)>,
    /// Has a `panActivation`: becomes the responder when the platform
    /// activates its pan, and is not asked before.
    pan_gated: bool,
    /// Values of props that may hold native animation nodes (`style`,
    /// `pan`, ...), kept alive with the view (owned).
    retained: Vec<(&'static str, JsValue)>,
    /// A `<Scroll>`'s content container (`contentStyle` /
    /// `contentClass`), one of `children` that takes the others
    /// ([`DETACHED`]: none).
    content: NodeId,
    /// A Rust component's view or one of its slots (`component`,
    /// `componentSlot`): the component places what is put in it, text in
    /// a text of its own maybe.
    places: bool,
    /// The node's object (not owned: the data goes with it).
    object: JsValue,
    /// The owner it was made under (`reactive::owner_handle`): its
    /// listeners' failures go to that owner's error boundary.
    owner: (u32, u32),
}

struct Handler {
    event: EventKind,
    value: JsValue,
}

/// The renderer of `cx`.
#[inline]
fn dom<'a>(cx: *mut JsContext) -> &'a Dom {
    // SAFETY: a projection of the state's field; the renderer is only ever
    // reached by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }
}

/// The node data an object holds, or null for other values.
#[inline]
fn node_ptr(cx: *mut JsContext, v: JsValue) -> *mut NodeData {
    // SAFETY: reads the opaque pointer only for objects of the node class.
    unsafe { qjs::JS_GetOpaque(v, dom(cx).classes.node) as *mut NodeData }
}

/// Whether two values are the same object.
#[inline]
fn same(a: JsValue, b: JsValue) -> bool {
    // SAFETY: inline tag and pointer reads.
    unsafe {
        qjs::JS_VALUE_GET_TAG(a) == qjs::JS_TAG_OBJECT
            && qjs::JS_VALUE_GET_TAG(b) == qjs::JS_TAG_OBJECT
            && qjs::JS_VALUE_GET_PTR(a) == qjs::JS_VALUE_GET_PTR(b)
    }
}

#[inline]
fn ptr_of(v: JsValue) -> usize {
    // SAFETY: inline pointer read.
    unsafe { qjs::JS_VALUE_GET_PTR(v) as usize }
}

fn throw_type(cx: *mut JsContext, message: &str) -> JsValue {
    let message = std::ffi::CString::new(message).unwrap_or_default();
    // SAFETY: throws on a live context; `%s` keeps the message literal.
    unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) }
}

/// A JS value's string (`ToString`), or `None` when that throws.
pub(crate) fn string_arg(cx: *mut JsContext, v: JsValue) -> Option<String> {
    to_string(cx, v)
}

/// A JS value's string (`ToString`), or `None` when that throws.
fn to_string(cx: *mut JsContext, v: JsValue) -> Option<String> {
    // SAFETY: a live value; the C string is freed below.
    unsafe {
        let mut len = 0usize;
        let p = qjs::JS_ToCStringLen(cx, &mut len, v);
        if p.is_null() {
            return None;
        }
        let s =
            String::from_utf8_lossy(std::slice::from_raw_parts(p.cast::<u8>(), len)).into_owned();
        qjs::JS_FreeCString(cx, p);
        Some(s)
    }
}

impl Dom {
    pub(crate) fn new(raw: *mut JsContext, shared: Rc<Shared>) -> Dom {
        // SAFETY: registering classes on the context's runtime.
        let classes = unsafe {
            let rt = qjs::JS_GetRuntime(raw);
            let class = |name: &'static CStr,
                         finalizer: qjs::JSClassFinalizer,
                         gc_mark: qjs::JSClassGCMark,
                         call: qjs::JSClassCall| {
                let mut id: qjs::JSClassID = 0;
                qjs::JS_NewClassID(rt, &mut id);
                let def = qjs::JSClassDef {
                    class_name: name.as_ptr(),
                    finalizer,
                    gc_mark,
                    call,
                    exotic: ptr::null_mut(),
                };
                qjs::JS_NewClass(rt, id, &def);
                id
            };
            let classes = Classes {
                node: class(c"Node", Some(node_finalize), Some(node_mark), None),
                each: class(c"EachRows", Some(each_finalize), Some(each_mark), None),
                context: class(
                    c"Context",
                    Some(context_finalize),
                    Some(context_mark),
                    Some(context_call),
                ),
            };
            // Calls of a context are function calls.
            qjs::JS_SetClassProto(raw, classes.context, qjs::JS_GetFunctionProto(raw));
            // A node's methods send commands to its view.
            let proto = qjs::JS_NewObject(raw);
            for (name, length, ..) in NODE_METHODS {
                let mut data = [qjs::JS_NewStringLen(
                    raw,
                    name.as_ptr().cast(),
                    name.len() as _,
                )];
                let f = qjs::JS_NewCFunctionData(
                    raw,
                    Some(node_method),
                    *length,
                    0,
                    1,
                    data.as_mut_ptr(),
                );
                qjs::JS_FreeValue(raw, data[0]);
                let cname = std::ffi::CString::new(*name).unwrap_or_default();
                qjs::JS_SetPropertyStr(raw, proto, cname.as_ptr(), f);
            }
            qjs::JS_SetClassProto(raw, classes.node, proto);
            classes
        };
        Dom {
            shared,
            classes,
            next_id: Cell::new(2),
            nodes: RefCell::new(Vec::new()),
            root: Cell::new(UNDEFINED),
            os: Cell::new(Os::Ios),
            desktop: Cell::new(false),
            rtl: Cell::new(None),
            env_rtl: Cell::new(false),
            unshown_text: Cell::new(0),
            dismissed: RefCell::new(Vec::new()),
        }
    }

    /// Frees the values the renderer holds (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        // SAFETY: the renderer's own value; no JS runs from here on.
        unsafe { qjs::JS_FreeValue(raw, self.root.replace(UNDEFINED)) };
        for (_, v) in self.dismissed.take() {
            // SAFETY: values the renderer owned.
            unsafe { qjs::JS_FreeValue(raw, v) };
        }
    }

    /// The platform `ios={{…}}` / `android={{…}}` / `web={{…}}` props are
    /// for, and whether `desktop={{…}}` props apply.
    pub(crate) fn set_platform(&self, os: Os, desktop: bool) {
        self.os.set(os);
        self.desktop.set(desktop);
    }

    /// The platform the app runs on.
    pub(crate) fn os(&self) -> Os {
        self.os.get()
    }

    /// Queues the release of a collected animation node or composite (from
    /// a finalizer).
    pub(crate) fn queue_animation_release(&self, op: nsh_core::animation::AnimationOp) {
        self.shared.animation_releases.borrow_mut().push(op);
    }

    /// The surface's layout direction (sent once something is mounted).
    pub(crate) fn set_direction(&self, rtl: bool) {
        self.env_rtl.set(rtl);
        if self.rtl.get().is_some_and(|sent| sent != rtl) {
            self.send_direction();
        }
    }

    fn send_direction(&self) {
        let rtl = self.env_rtl.get();
        self.rtl.set(Some(rtl));
        self.shared.ops.borrow_mut().push(Op::SetProp {
            id: ROOT,
            prop: nsh_core::Prop::LayoutDirection(rtl),
        });
    }

    /// Queues `op`; `Err` (with a thrown error) over the VM's limit.
    fn push(&self, cx: *mut JsContext, op: Op) -> Result<(), JsValue> {
        let mut ops = self.shared.ops.borrow_mut();
        if ops.len() >= self.shared.limits.max_op_values {
            drop(ops);
            let reason = format!(
                "the app made more than {} changes at once and was stopped",
                self.shared.limits.max_op_values
            );
            self.shared.stop(reason.clone());
            // SAFETY: throws on a live context.
            return Err(unsafe {
                let message = std::ffi::CString::new(reason).unwrap_or_default();
                qjs::JS_ThrowRangeError(cx, c"%s".as_ptr(), message.as_ptr())
            });
        }
        ops.push(op);
        Ok(())
    }

    fn by_id(&self, id: NodeId) -> *mut NodeData {
        self.nodes
            .borrow()
            .get((id >> 1) as usize)
            .copied()
            .unwrap_or(ptr::null_mut())
    }
}

/// The methods of nodes (`ref` objects): each sends a command to the
/// node's view, in order with the ops before it. Name, `length`, signature
/// and documentation (the declaration of `YNode`).
pub(crate) const NODE_METHODS: &[(&str, c_int, &str, &str)] = &[
    (
        "focus",
        0,
        decl!("(): void"),
        decl!("Focuses an `<Input>` (shows the keyboard)."),
    ),
    (
        "blur",
        0,
        decl!("(): void"),
        decl!("Unfocuses an `<Input>`."),
    ),
    (
        "setSelection",
        2,
        decl!("(start: number, end?: number): void"),
        decl!("Inputs: selects `start..end` (UTF-16 units; a caret without `end`)."),
    ),
    (
        "replaceRange",
        1,
        decl!(
            "(edit: { start: number; end: number; text: string; expectedText: string; expectedSelection: { start: number; end: number } }): void"
        ),
        decl!(
            "Inputs: atomically replaces a UTF-16 range as one undoable edit while the observed text and selection still match. GPUI and terminal backends."
        ),
    ),
    (
        "command",
        2,
        decl!("(name: string, args?: unknown): void"),
        decl!(
            "Calls command `name` of a registered native component (`nsh/native`) with `args` (any JSON value)."
        ),
    ),
    (
        "scrollTo",
        1,
        decl!("(options: { x?: number; y?: number; animated?: boolean }): void"),
        decl!("Scrolls a `<Scroll>` or `List` to an offset."),
    ),
    (
        "zoomTo",
        1,
        decl!("(options: { scale: number; x?: number; y?: number; animated?: boolean }): void"),
        decl!(
            "A zoomable `<Scroll>` (`maximumZoomScale` above `minimumZoomScale`): zooms to `scale` (clamped to the limits), with the content point (`x`, `y`) (unzoomed points) in the middle of the viewport, or around the middle. E.g. double tap to zoom in on the tapped point."
        ),
    ),
    (
        "scrollToOffset",
        1,
        decl!("(options: { offset: number; animated?: boolean }): void"),
        decl!("`List`: scrolls to a content offset along the list's axis."),
    ),
    (
        "scrollToIndex",
        1,
        decl!(
            "(options: { index: number; animated?: boolean; automatic?: boolean; viewPosition?: number; viewOffset?: number }): void"
        ),
        decl!(
            "`List`: scrolls item `index` into view. `viewPosition` places it: 0 at the start of the viewport (default), 0.5 in the middle, 1 at the end; `viewOffset` shifts it further. Resolved natively with the current (measured or estimated) item sizes. On GPUI and terminal backends, `automatic` retains only the latest target while native hover or keyboard focus is within the list, and resumes when idle."
        ),
    ),
    (
        "scrollToEnd",
        1,
        decl!("(options?: { animated?: boolean }): void"),
        decl!("`List`: scrolls to the end of the content (the start of an inverted list)."),
    ),
    (
        "measure",
        0,
        decl!("(): Promise<{ bounds: Bounds; pagePosition: Point } | null>"),
        decl!(
            "Where the view is once this turn's changes are laid out: `bounds` its frame in its parent (as `onLayout`), `pagePosition` its top left corner in the root view it is in (the surface, or its modal), the coordinates of touches' `pageX` / `pageY`: `event.pageX - m.pagePosition.x` is a touch's position in the view. Scroll offsets and zoom scales of the scroll views and lists around it are applied, transforms (animations included) are not. `null` when the view is not in the tree."
        ),
    ),
    (
        "reload",
        0,
        decl!("(): void"),
        decl!("`WebView`: reloads the page."),
    ),
    (
        "goBack",
        0,
        decl!("(): void"),
        decl!("`WebView`: goes back in its history."),
    ),
    (
        "goForward",
        0,
        decl!("(): void"),
        decl!("`WebView`: goes forward in its history."),
    ),
    (
        "stopLoading",
        0,
        decl!("(): void"),
        decl!("`WebView`: stops loading."),
    ),
    (
        "injectJavaScript",
        1,
        decl!("(script: string): void"),
        decl!("`WebView`: runs JavaScript in the page."),
    ),
    (
        "postMessage",
        1,
        decl!("(data: string): void"),
        decl!("`WebView`: sends `data` to the page (a `message` event on `window`)."),
    ),
    (
        "seek",
        1,
        decl!("(seconds: number): void"),
        decl!("`Video`: jumps to `seconds`."),
    ),
];

/// A node method: `this` is the node, data the method's name.
unsafe extern "C" fn node_method(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the name); arguments are borrowed; values
    // made here are freed.
    let Some(name) = to_string(cx, unsafe { *data }) else {
        return qjs::JS_EXCEPTION;
    };
    let Some(id) = node_id(cx, this) else {
        return throw_type(cx, "nsh: not a node");
    };
    if name == "measure" {
        return crate::components::measure(cx, id);
    }
    let a0 = arg(argc, argv, 0);
    let number = |v: JsValue| -> JsValue {
        let mut n = 0f64;
        unsafe { qjs::JS_ToFloat64(cx, &mut n, v) };
        qjs::JS_NewFloat64(n)
    };
    let field = |obj: JsValue, key: &CStr| -> JsValue {
        unsafe {
            if qjs::JS_IsObject(obj) {
                qjs::JS_GetPropertyStr(cx, obj, key.as_ptr())
            } else {
                UNDEFINED
            }
        }
    };
    let (command, argument) = unsafe {
        match name.as_str() {
            "setSelection" => {
                let o = qjs::JS_NewObject(cx);
                let start = number(a0);
                let a1 = arg(argc, argv, 1);
                let end = if qjs::JS_IsUndefined(a1) {
                    start
                } else {
                    number(a1)
                };
                qjs::JS_SetPropertyStr(cx, o, c"start".as_ptr(), start);
                qjs::JS_SetPropertyStr(cx, o, c"end".as_ptr(), end);
                ("setSelection", o)
            }
            "command" => {
                let o = qjs::JS_NewObject(cx);
                qjs::JS_SetPropertyStr(cx, o, c"name".as_ptr(), qjs::JS_DupValue(cx, a0));
                qjs::JS_SetPropertyStr(
                    cx,
                    o,
                    c"args".as_ptr(),
                    qjs::JS_DupValue(cx, arg(argc, argv, 1)),
                );
                ("native", o)
            }
            "scrollToOffset" => {
                let o = qjs::JS_NewObject(cx);
                let offset = field(a0, c"offset");
                qjs::JS_SetPropertyStr(cx, o, c"x".as_ptr(), qjs::JS_DupValue(cx, offset));
                qjs::JS_SetPropertyStr(cx, o, c"y".as_ptr(), offset);
                qjs::JS_SetPropertyStr(cx, o, c"animated".as_ptr(), field(a0, c"animated"));
                ("scrollTo", o)
            }
            "scrollToEnd" if qjs::JS_IsUndefined(a0) => ("scrollToEnd", qjs::JS_NewObject(cx)),
            other => (
                NODE_METHODS
                    .iter()
                    .find(|(n, ..)| *n == other)
                    .map_or("", |(n, ..)| *n),
                qjs::JS_DupValue(cx, a0),
            ),
        }
    };
    // SAFETY: a context reference for the decoder, which takes `argument`.
    let js_cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(cx)) };
    let value = unsafe { Value::from_raw(js_cx, argument) };
    match crate::protocol::decode_command(command, value) {
        Ok(Some(command)) => dom(cx)
            .push(cx, Op::Command { id, command })
            .err()
            .unwrap_or(UNDEFINED),
        Ok(None) => UNDEFINED,
        Err(rquickjs::Error::Exception) => qjs::JS_EXCEPTION,
        Err(e) => throw_type(cx, &format!("nsh: {name}: {e}")),
    }
}

/// Makes the root view's object (after the state is installed).
pub(crate) fn init(raw: *mut JsContext) {
    let root = new_node(raw, ROOT, false, None);
    dom(raw).root.set(root);
}

/// A new node object for id `id` (owned).
fn new_node(cx: *mut JsContext, id: NodeId, text: bool, tag: Option<Tag>) -> JsValue {
    let d = dom(cx);
    let data = Box::into_raw(Box::new(NodeData {
        id,
        text,
        tag,
        popped: UNDEFINED,
        touch: Vec::new(),
        pan_gated: false,
        retained: Vec::new(),
        parent: DETACHED,
        children: Vec::new(),
        handlers: Vec::new(),
        content: DETACHED,
        places: false,
        object: UNDEFINED,
        owner: reactive::owner_handle(cx),
    }));
    // SAFETY: a registered class; the opaque is the boxed data, freed by
    // the finalizer.
    let obj = unsafe {
        let obj = qjs::JS_NewObjectClass(cx, d.classes.node as _);
        qjs::JS_SetOpaque(obj, data as *mut c_void);
        (*data).object = obj;
        obj
    };
    let index = (id >> 1) as usize;
    let mut nodes = d.nodes.borrow_mut();
    if nodes.len() <= index {
        nodes.resize(index + 1, ptr::null_mut());
    }
    nodes[index] = data;
    obj
}

/// Logs `message` with the VM's warnings (once), as a host prop's.
pub(crate) fn warn(cx: *mut JsContext, message: String) {
    dom(cx).shared.warnings.borrow_mut().warn(message);
}

/// Logs what `warnings` collected, with the VM's (each once).
pub(crate) fn merge_warnings(cx: *mut JsContext, warnings: crate::protocol::Warnings) {
    dom(cx).shared.warnings.borrow_mut().merge(warnings);
}

/// Node `id`'s object (owned), or `null` once JS let it go.
pub(crate) fn node_value(cx: *mut JsContext, id: NodeId) -> JsValue {
    let p = dom(cx).by_id(id);
    if p.is_null() {
        return qjs::JS_NULL;
    }
    // SAFETY: live node data (it leaves the table when its object is
    // finalized); the object is live while it is there.
    unsafe { qjs::JS_DupValue(cx, (*p).object) }
}

/// The id of node object `v`, if it is one.
pub(crate) fn node_id(cx: *mut JsContext, v: JsValue) -> Option<NodeId> {
    let p = node_ptr(cx, v);
    // SAFETY: live node data.
    (!p.is_null()).then(|| unsafe { (*p).id })
}

/// Keeps `value` (borrowed; objects only) alive with node `node` under
/// `key`, replacing what it kept there: the animated values a view reads.
pub(crate) fn retain(cx: *mut JsContext, node: JsValue, key: &'static str, value: JsValue) {
    let p = node_ptr(cx, node);
    if !p.is_null() {
        retain_in(cx, p, key, value);
    }
}

fn retain_in(cx: *mut JsContext, p: *mut NodeData, key: &'static str, value: JsValue) {
    // SAFETY: live node data; the node owns a dup; the old one is freed
    // after the borrow ends (its finalizer may run).
    let old = unsafe {
        let retained = &mut (*p).retained;
        let old = retained
            .iter()
            .position(|(k, _)| *k == key)
            .map(|i| retained.remove(i).1);
        if qjs::JS_IsObject(value) {
            retained.push((key, qjs::JS_DupValue(cx, value)));
        }
        old
    };
    if let Some(old) = old {
        // SAFETY: the value the node owned.
        unsafe { qjs::JS_FreeValue(cx, old) };
    }
}

/// The host's shared state.
pub(crate) fn shared(cx: *mut JsContext) -> Rc<Shared> {
    dom(cx).shared.clone()
}

/// `merge(...values)` (borrowed): a new object (owned).
pub(crate) fn merge_values(cx: *mut JsContext, values: &mut [JsValue]) -> JsValue {
    // SAFETY: borrowed arguments, as `merge` takes them.
    unsafe { merge(cx, UNDEFINED, values.len() as c_int, values.as_mut_ptr()) }
}

/// Queues `op` (for the components' glue).
pub(crate) fn push_op(cx: *mut JsContext, op: Op) -> Result<(), JsValue> {
    dom(cx).push(cx, op)
}

/// A new host element (owned).
pub(crate) fn create_element(cx: *mut JsContext, tag: Tag) -> Result<JsValue, JsValue> {
    let id = next_id(cx);
    dom(cx).push(cx, Op::Create { id, tag })?;
    Ok(new_node(cx, id, false, Some(tag)))
}

/// The tag of element `v`, if it is one.
pub(crate) fn node_tag(cx: *mut JsContext, v: JsValue) -> Option<Tag> {
    let p = node_ptr(cx, v);
    // SAFETY: live node data.
    if p.is_null() {
        None
    } else {
        unsafe { (*p).tag }
    }
}

/// Sets screen `v`'s callback for a native pop to `f` (borrowed).
pub(crate) fn set_popped(cx: *mut JsContext, v: JsValue, f: JsValue) {
    let p = node_ptr(cx, v);
    if p.is_null() {
        return;
    }
    // SAFETY: live node data; the node owns a dup; the old one is freed.
    unsafe {
        let old = std::mem::replace(&mut (*p).popped, qjs::JS_DupValue(cx, f));
        qjs::JS_FreeValue(cx, old);
    }
}

/// Screen `v`'s callback for a native pop (owned), if set.
pub(crate) fn popped(cx: *mut JsContext, v: JsValue) -> JsValue {
    let p = node_ptr(cx, v);
    if p.is_null() {
        return UNDEFINED;
    }
    // SAFETY: a dup of what the node owns.
    unsafe { qjs::JS_DupValue(cx, (*p).popped) }
}

/// [`spread`] of `props` onto `node` without the keys `skip`.
pub(crate) fn spread_except(
    cx: *mut JsContext,
    node: JsValue,
    props: JsValue,
    skip: &[&str],
) -> Result<(), JsValue> {
    let mut keys: Vec<JsValue> = skip
        .iter()
        // SAFETY: new strings the array takes.
        .map(|k| unsafe { qjs::JS_NewStringLen(cx, k.as_ptr().cast(), k.len() as _) })
        .collect();
    let skip = unsafe { qjs::JS_NewArrayFrom(cx, keys.len() as c_int, keys.as_mut_ptr()) };
    let mut data = [node, props, skip];
    // SAFETY: the function keeps dups of `data`; ours is freed.
    let func =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(spread_run), 1, 1, 3, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, skip) };
    let r = reactive::render_effect(cx, func);
    unsafe { qjs::JS_FreeValue(cx, r) };
    let r = reactive::finish_value(cx, UNDEFINED);
    if unsafe { qjs::JS_IsException(r) } {
        Err(r)
    } else {
        Ok(())
    }
}

/// Sets prop `name` of `node` (borrowed values) to `value`.
pub(crate) fn set_prop_value(
    cx: *mut JsContext,
    node: JsValue,
    name: &str,
    value: JsValue,
) -> Result<(), JsValue> {
    set_prop(cx, node, name, value, UNDEFINED)
}

/// Sets prop `name` of `node` from `prev` to `value` (borrowed values).
pub(crate) fn set_prop_with_prev(
    cx: *mut JsContext,
    node: JsValue,
    name: &str,
    value: JsValue,
    prev: JsValue,
) -> Result<(), JsValue> {
    set_prop(cx, node, name, value, prev)
}

/// Sets node `id`'s handler of `event` to `f` (borrowed; not a function:
/// none).
pub(crate) fn set_handler(
    cx: *mut JsContext,
    id: NodeId,
    event: EventKind,
    f: JsValue,
) -> Result<(), JsValue> {
    let p = dom(cx).by_id(id);
    if p.is_null() {
        return Ok(());
    }
    set_event(cx, p, event, f)
}

/// Inserts `value` into `parent` before `marker` (as `insert`).
pub(crate) fn insert_value_at(
    cx: *mut JsContext,
    parent: JsValue,
    value: JsValue,
    marker: Option<JsValue>,
) -> Result<(), JsValue> {
    insert_value(cx, parent, value, marker)
}

/// Removes node `child` from `parent`.
pub(crate) fn remove_node(
    cx: *mut JsContext,
    parent: JsValue,
    child: JsValue,
) -> Result<(), JsValue> {
    remove_child(cx, parent, child)
}

/// Moves node `child` into `parent` before `before`.
pub(crate) fn insert_node(
    cx: *mut JsContext,
    parent: JsValue,
    child: JsValue,
    before: Option<JsValue>,
) -> Result<(), JsValue> {
    insert_before(cx, parent, child, before)
}

/// How many removed modals' `onDismiss` handlers wait for their dismissal
/// at most (a modal removed before it was presented never gets one).
const MAX_DISMISSED: usize = 16;

fn next_id(cx: *mut JsContext) -> NodeId {
    let d = dom(cx);
    let id = d.next_id.get();
    d.next_id.set(id + 2);
    id
}

unsafe extern "C" fn node_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of a node object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut NodeData;
    if p.is_null() {
        return;
    }
    let mut data = unsafe { Box::from_raw(p) };
    if let Some(state) = crate::state::of_runtime(rt) {
        // SAFETY: a projection of the live state's renderer.
        let d = unsafe { &(*state).dom };
        let index = (data.id >> 1) as usize;
        if let Some(slot) = d.nodes.borrow_mut().get_mut(index)
            && *slot == p
        {
            *slot = ptr::null_mut();
        }
        if data.id != ROOT {
            // Not the op queue: a finalizer may run while it is borrowed.
            d.shared.releases.borrow_mut().push(data.id);
        }
        // A removed modal still hears its dismissal.
        if data.tag == Some(Tag::Modal)
            && let Some(i) = data
                .handlers
                .iter()
                .position(|h| h.event == EventKind::Dismiss)
        {
            let handler = data.handlers.swap_remove(i);
            let oldest = {
                let mut dismissed = d.dismissed.borrow_mut();
                dismissed.push((data.id, handler.value));
                (dismissed.len() > MAX_DISMISSED).then(|| dismissed.remove(0).1)
            };
            if let Some(v) = oldest {
                // SAFETY: a value the renderer owned, freed after the borrow.
                unsafe { qjs::JS_FreeValueRT(rt, v) };
            }
        }
    }
    for v in data.children {
        // SAFETY: values the node owned.
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
    for v in data
        .handlers
        .into_iter()
        .map(|h| h.value)
        .chain(data.touch.into_iter().map(|(_, v)| v))
        .chain(data.retained.into_iter().map(|(_, v)| v))
    {
        unsafe { qjs::JS_FreeValueRT(rt, v) };
    }
    unsafe { qjs::JS_FreeValueRT(rt, data.popped) };
}

unsafe extern "C" fn node_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const NodeData;
    if p.is_null() {
        return;
    }
    let data = unsafe { &*p };
    for &v in &data.children {
        unsafe { qjs::JS_MarkValue(rt, v, mark) };
    }
    for handler in &data.handlers {
        unsafe { qjs::JS_MarkValue(rt, handler.value, mark) };
    }
    for v in data
        .touch
        .iter()
        .map(|&(_, v)| v)
        .chain(data.retained.iter().map(|&(_, v)| v))
    {
        unsafe { qjs::JS_MarkValue(rt, v, mark) };
    }
    unsafe { qjs::JS_MarkValue(rt, data.popped, mark) };
}

// --- The tree mirror ----------------------------------------------------------

/// The node after `child` in its parent (`None`: the last one, or not a
/// child).
fn next_sibling(cx: *mut JsContext, child: JsValue) -> Option<JsValue> {
    let c = node_ptr(cx, child);
    if c.is_null() {
        return None;
    }
    // SAFETY: live node data, read without other references to it.
    let parent = unsafe { (*c).parent };
    let p = dom(cx).by_id(parent);
    if p.is_null() {
        return None;
    }
    let children = unsafe { &(*p).children };
    let i = children.iter().position(|&v| same(v, child))?;
    children.get(i + 1).copied()
}

/// Whether `node` is `of` or one of its ancestors.
fn is_ancestor(cx: *mut JsContext, node: NodeId, of: NodeId) -> bool {
    let d = dom(cx);
    let mut at = of;
    while at != DETACHED {
        if at == node {
            return true;
        }
        let p = d.by_id(at);
        if p.is_null() {
            return false;
        }
        // SAFETY: live node data.
        at = unsafe { (*p).parent };
    }
    false
}

/// Reports text put in an element of `tag` (`None`: the root), which does
/// not show it, once per tag: only a `<Text>` shows text. Text the source
/// holds is a compile error; this is a string an expression gives
/// (`<View>{name}</View>`).
#[cold]
fn report_unshown_text(cx: *mut JsContext, tag: Option<Tag>) {
    let d = dom(cx);
    let bit = 1u64 << tag.map_or(63, |t| t as u32);
    if d.unshown_text.get() & bit != 0 {
        return;
    }
    d.unshown_text.set(d.unshown_text.get() | bit);
    let place = match tag {
        None => "the root".to_owned(),
        Some(Tag::Cell) => "a <List> row".to_owned(),
        Some(tag) => format!("a <{tag:?}>"),
    };
    d.shared.warnings.borrow_mut().warn(format!(
        "a string in {place} is not shown: text shows in a <Text> (`<Text>{{name}}</Text>`)"
    ));
}

/// The tags text was put in unshown ([`report_unshown_text`]'s bits).
#[cfg(test)]
pub(crate) fn unshown_text_tags(cx: *mut JsContext) -> u64 {
    dom(cx).unshown_text.get()
}

/// Moves node `child` into `parent` before `before` (`None`: at the end).
fn insert_before(
    cx: *mut JsContext,
    parent: JsValue,
    child: JsValue,
    before: Option<JsValue>,
) -> Result<(), JsValue> {
    let parent = content_of(cx, parent, child);
    let (p, c) = (node_ptr(cx, parent), node_ptr(cx, child));
    if p.is_null() || c.is_null() {
        return Err(throw_type(cx, "nsh: not a node"));
    }
    if before.is_some_and(|b| same(b, child)) {
        return Ok(());
    }
    // Already there: no move.
    // SAFETY: live node data.
    if unsafe { (*c).parent == (*p).id } {
        let next = next_sibling(cx, child);
        let in_place = match (next, before) {
            (None, None) => true,
            (Some(n), Some(b)) => same(n, b),
            _ => false,
        };
        if in_place {
            return Ok(());
        }
    }
    // SAFETY: live node data; `p` and `c` differ (no node is its own
    // parent: checked below), each reached briefly.
    let (parent_id, child_id) = unsafe { ((*p).id, (*c).id) };
    if is_ancestor(cx, child_id, parent_id) {
        return Err(throw_type(cx, "nsh: a node cannot be inserted into itself"));
    }
    // SAFETY: live node data, read briefly.
    if unsafe { (*c).text && !(*p).places && (*p).tag != Some(Tag::Text) } {
        report_unshown_text(cx, unsafe { (*p).tag });
    }
    let d = dom(cx);
    // Out of its current parent (the core moves the view itself).
    let mut held = None;
    let old = unsafe { (*c).parent };
    if old != DETACHED {
        let op = d.by_id(old);
        if !op.is_null() {
            let children = unsafe { &mut (*op).children };
            if let Some(i) = children.iter().position(|&v| same(v, child)) {
                held = Some(children.remove(i));
            }
        }
    }
    let children = unsafe { &mut (*p).children };
    let (pos, before_id) = match before {
        Some(b) => match children.iter().position(|&v| same(v, b)) {
            Some(i) => (i, Some(unsafe { (*node_ptr(cx, b)).id })),
            None => (children.len(), None),
        },
        None => (children.len(), None),
    };
    // SAFETY: a dup the parent owns from now on.
    let owned = held.unwrap_or_else(|| unsafe { qjs::JS_DupValue(cx, child) });
    children.insert(pos, owned);
    unsafe { (*c).parent = parent_id };
    d.push(
        cx,
        Op::Insert {
            parent: parent_id,
            child: child_id,
            before: before_id,
        },
    )
}

/// Where `parent`'s child `child` lives: the content container of a
/// `<Scroll>` that has one (for any child but the container), else
/// `parent` (borrowed values).
fn content_of(cx: *mut JsContext, parent: JsValue, child: JsValue) -> JsValue {
    let p = node_ptr(cx, parent);
    // SAFETY: live node data, read briefly.
    if p.is_null() || unsafe { (*p).content } == DETACHED {
        return parent;
    }
    let content = unsafe { (*p).content };
    if node_id(cx, child) == Some(content) {
        return parent;
    }
    unsafe { &(*p).children }
        .iter()
        .copied()
        .find(|&v| node_id(cx, v) == Some(content))
        .unwrap_or(parent)
}

/// The content container of `<Scroll>` `node` (borrowed), made on first
/// use: a view the scroll view's children move into, styled by
/// `contentStyle` / `contentClass` (React Native's
/// content container: `flexGrow: 1` with `justifyContent: "center"`
/// centers what is shorter than the viewport and still scrolls what is
/// longer).
fn scroll_content(cx: *mut JsContext, node: JsValue) -> Result<JsValue, JsValue> {
    let p = node_ptr(cx, node);
    // SAFETY: live node data, read briefly.
    let existing = unsafe { (*p).content };
    if existing != DETACHED {
        return Ok(content_of(cx, node, UNDEFINED));
    }
    let id = next_id(cx);
    dom(cx).push(cx, Op::Create { id, tag: Tag::View })?;
    let content = new_node(cx, id, false, Some(Tag::View));
    // The children so far move in, in order.
    let children: Vec<JsValue> = unsafe { &(*p).children }
        .iter()
        // SAFETY: dups held while they move.
        .map(|&v| unsafe { qjs::JS_DupValue(cx, v) })
        .collect();
    let first = children.first().copied();
    let mut result = insert_before(cx, node, content, first);
    unsafe { (*p).content = id };
    for &child in &children {
        if result.is_ok() {
            result = insert_before(cx, content, child, None);
        }
    }
    free_values(cx, children);
    // The scroll view owns it now (as its child).
    unsafe { qjs::JS_FreeValue(cx, content) };
    result.map(|()| content_of(cx, node, UNDEFINED))
}

/// A state or part style prop's value (borrowed) as the core takes it:
/// its declarations, none when it has none.
fn part_style(
    cx: *mut JsContext,
    name: &str,
    value: JsValue,
) -> Result<Option<std::sync::Arc<nsh_core::StylePatch>>, JsValue> {
    // SAFETY: a context reference for the decoder, which reads a dup.
    let js_cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(cx)) };
    let v = unsafe { Value::from_raw(js_cx, qjs::JS_DupValue(cx, value)) };
    let mut warnings = crate::protocol::Warnings::deferred();
    let patch = crate::protocol::style_patch(&v, &mut warnings);
    dom(cx).shared.warnings.borrow_mut().merge(warnings);
    match patch {
        Ok(patch) => Ok((!patch.is_empty()).then(|| std::sync::Arc::new(patch))),
        Err(rquickjs::Error::Exception) => Err(qjs::JS_EXCEPTION),
        Err(e) => Err(throw_type(cx, &format!("nsh: prop `{name}`: {e}"))),
    }
}

/// Removes node `child` from `parent` (nothing when it is not a child).
fn remove_child(cx: *mut JsContext, parent: JsValue, child: JsValue) -> Result<(), JsValue> {
    let parent = content_of(cx, parent, child);
    let (p, c) = (node_ptr(cx, parent), node_ptr(cx, child));
    if p.is_null() || c.is_null() {
        return Ok(());
    }
    // SAFETY: live node data, reached briefly.
    let (parent_id, child_id) = unsafe { ((*p).id, (*c).id) };
    if unsafe { (*c).parent } != parent_id {
        return Ok(());
    }
    let children = unsafe { &mut (*p).children };
    let Some(i) = children.iter().position(|&v| same(v, child)) else {
        return Ok(());
    };
    let owned = children.remove(i);
    unsafe { (*c).parent = DETACHED };
    let pushed = dom(cx).push(
        cx,
        Op::Remove {
            parent: parent_id,
            child: child_id,
        },
    );
    // Last: this may finalize the child.
    unsafe { qjs::JS_FreeValue(cx, owned) };
    pushed
}

// --- Elements, text, props -----------------------------------------------------

/// `element(tag)`: a new host element.
unsafe extern "C" fn element(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(name) = to_string(cx, arg(argc, argv, 0)) else {
        return qjs::JS_EXCEPTION;
    };
    let tag = Tag::from_name(&name).unwrap_or_else(|| {
        dom(cx)
            .shared
            .warnings
            .borrow_mut()
            .warn(format!("unknown element <{name}>, rendering it as <view>"));
        Tag::View
    });
    let id = next_id(cx);
    if let Err(e) = dom(cx).push(cx, Op::Create { id, tag }) {
        return e;
    }
    new_node(cx, id, false, Some(tag))
}

/// A new text node showing `text`.
fn text_node(cx: *mut JsContext, text: String) -> Result<JsValue, JsValue> {
    let id = next_id(cx);
    dom(cx).push(cx, Op::CreateText { id, text })?;
    Ok(new_node(cx, id, true, None))
}

/// `text(value)`: a new text node.
unsafe extern "C" fn text(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(s) = to_string(cx, arg(argc, argv, 0)) else {
        return qjs::JS_EXCEPTION;
    };
    text_node(cx, s).unwrap_or_else(|e| e)
}

/// `append(parent, child)`: a static child at the end.
unsafe extern "C" fn append(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (parent, child) = (arg(argc, argv, 0), arg(argc, argv, 1));
    let result = if node_ptr(cx, child).is_null() {
        insert_value(cx, parent, child, None)
    } else {
        insert_before(cx, parent, child, None)
    };
    result.err().unwrap_or(UNDEFINED)
}

/// Sets prop `name` of node `node` to `value` (all borrowed): an event
/// handler, the platform props, the ref, or a host prop the core decodes.
fn set_prop(
    cx: *mut JsContext,
    node: JsValue,
    name: &str,
    value: JsValue,
    prev: JsValue,
) -> Result<(), JsValue> {
    let p = node_ptr(cx, node);
    if p.is_null() {
        return Err(throw_type(cx, "nsh: not a node"));
    }
    // SAFETY: live node data.
    let id = unsafe { (*p).id };
    match name {
        "children" => return Ok(()),
        "ref" => {
            apply_ref(cx, value, node)?;
            return Ok(());
        }
        // SAFETY: live node data.
        "component" | "componentSlot" => unsafe { (*p).places = true },
        "ios" | "android" | "desktop" | "web" => {
            return platform_props(cx, node, name, value, prev);
        }
        "contentStyle" | "contentClass" if unsafe { (*p).tag } == Some(Tag::Scroll) => {
            let content = scroll_content(cx, node)?;
            let name = if name == "contentStyle" {
                "style"
            } else {
                "class"
            };
            return set_prop(cx, content, name, value, prev);
        }
        "activeStyle" | "hoverStyle" | "focusStyle" | "disabledStyle" | "selectedStyle"
        | "checkedStyle" | "indeterminateStyle" | "headerStyle" => {
            let patch = part_style(cx, name, value)?;
            let prop = match name {
                "activeStyle" => nsh_core::Prop::ActiveStyle(patch),
                "hoverStyle" => nsh_core::Prop::HoverStyle(patch),
                "focusStyle" => nsh_core::Prop::FocusStyle(patch),
                "disabledStyle" => nsh_core::Prop::DisabledStyle(patch),
                "selectedStyle" => nsh_core::Prop::SelectedStyle(patch),
                "checkedStyle" => nsh_core::Prop::CheckedStyle(patch),
                "indeterminateStyle" => nsh_core::Prop::IndeterminateStyle(patch),
                _ => nsh_core::Prop::HeaderStyle(patch),
            };
            return dom(cx).push(cx, Op::SetProp { id, prop });
        }
        "headerClass" | "contentClass" => {
            // SAFETY: an inline tag check.
            let names: Box<str> = if unsafe { qjs::JS_IsString(value) } {
                string_arg(cx, value).unwrap_or_default().into()
            } else {
                Box::default()
            };
            let prop = match name {
                "headerClass" => nsh_core::Prop::HeaderClass(names),
                _ => nsh_core::Prop::ListContentClass(names),
            };
            return dom(cx).push(cx, Op::SetProp { id, prop });
        }
        _ => {}
    }
    if let Some(prop) = crate::touch::touch_prop(name) {
        return set_touch(cx, p, prop, value);
    }
    if name == "panActivation" {
        // SAFETY: live node data; an inline check of a borrowed value.
        unsafe { (*p).pan_gated = qjs::JS_IsObject(value) };
    }
    if name.len() > 2
        && name.starts_with("on")
        && name.as_bytes()[2].is_ascii_uppercase()
        && let Some(event) = EventKind::from_handler(name)
    {
        return set_event(cx, p, event, value);
    }
    // Native animation nodes these props use, and a `tooltip`'s element,
    // stay alive with the view.
    if let Some(&key) = [
        "style",
        "pan",
        "pinch",
        "rotation",
        "scrollValue",
        "pullValue",
        "stickyHeaderOffset",
        "tooltip",
    ]
    .iter()
    .find(|k| **k == name)
    {
        retain_in(cx, p, key, value);
    }
    // SAFETY: a context reference for the decoder, which reads `value`.
    let js_cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(cx)) };
    let v = unsafe { Value::from_raw(js_cx, qjs::JS_DupValue(cx, value)) };
    // Decoding may run JS (getters): no borrow is held meanwhile.
    let mut warnings = crate::protocol::Warnings::deferred();
    // SAFETY: live node data.
    let tag = unsafe { (*p).tag };
    let mut decoded = crate::protocol::decode_prop(id, tag, name, v, &mut warnings);
    dom(cx).shared.warnings.borrow_mut().merge(warnings);
    if let Ok(Some(Op::SetProp { prop, .. })) = &mut decoded {
        // A `blob:` URL's bytes are in this VM: they go with the source.
        crate::web::blob::resolve_image_source(cx, prop);
    }
    match decoded {
        Ok(Some(op)) => dom(cx).push(cx, op),
        Ok(None) => Ok(()),
        Err(rquickjs::Error::Exception) => Err(qjs::JS_EXCEPTION),
        Err(e) => Err(throw_type(cx, &format!("nsh: prop `{name}`: {e}"))),
    }
}

/// Sets the handler of `event` on node `p` to `value` (borrowed; not a
/// function: none) and tells the core whether the node listens.
fn set_event(
    cx: *mut JsContext,
    p: *mut NodeData,
    event: EventKind,
    value: JsValue,
) -> Result<(), JsValue> {
    // SAFETY: live node data; an inline check, then a dup the node owns.
    let id = unsafe { (*p).id };
    let handlers = unsafe { &mut (*p).handlers };
    let at = handlers.iter().position(|h| h.event == event);
    let handler = unsafe { qjs::JS_IsFunction(cx, value) }.then(|| Handler {
        event,
        value: unsafe { qjs::JS_DupValue(cx, value) },
    });
    let now = handler.is_some();
    let (was, old) = match (at, handler) {
        (Some(i), Some(h)) => (true, Some(std::mem::replace(&mut handlers[i], h))),
        (Some(i), None) => (true, Some(handlers.remove(i))),
        (None, Some(h)) => {
            handlers.push(h);
            (false, None)
        }
        (None, None) => (false, None),
    };
    let pushed = if was != now {
        dom(cx).push(
            cx,
            Op::Listen {
                id,
                event,
                enabled: now,
            },
        )
    } else {
        Ok(())
    };
    if let Some(old) = old {
        unsafe { qjs::JS_FreeValue(cx, old.value) };
    }
    pushed
}

/// Sets touch handler `prop` of node `p` to `value` (borrowed; not a
/// function: none); the view listens to touches while it has any.
fn set_touch(
    cx: *mut JsContext,
    p: *mut NodeData,
    prop: u8,
    value: JsValue,
) -> Result<(), JsValue> {
    // SAFETY: live node data; an inline check, then a dup the node owns.
    let id = unsafe { (*p).id };
    let handler =
        unsafe { qjs::JS_IsFunction(cx, value) }.then(|| unsafe { qjs::JS_DupValue(cx, value) });
    let touch = unsafe { &mut (*p).touch };
    let before = !touch.is_empty();
    let old = touch
        .iter()
        .position(|&(i, _)| i == prop)
        .map(|at| touch.remove(at).1);
    if let Some(h) = handler {
        touch.push((prop, h));
    }
    let after = !touch.is_empty();
    let pushed = if before != after {
        dom(cx).push(
            cx,
            Op::Listen {
                id,
                event: EventKind::Touch,
                enabled: after,
            },
        )
    } else {
        Ok(())
    };
    if let Some(old) = old {
        unsafe { qjs::JS_FreeValue(cx, old) };
    }
    pushed
}

/// Node `id`'s touch handler `prop` (owned), if it has one.
pub(crate) fn touch_handler(cx: *mut JsContext, id: NodeId, prop: u8) -> Option<JsValue> {
    let p = dom(cx).by_id(id);
    if p.is_null() {
        return None;
    }
    // SAFETY: live node data; a dup of the handler.
    unsafe { &(*p).touch }
        .iter()
        .find(|&&(i, _)| i == prop)
        .map(|&(_, h)| unsafe { qjs::JS_DupValue(cx, h) })
}

/// Whether node `id` has touch handler `prop`.
pub(crate) fn touch_handler_exists(cx: *mut JsContext, id: NodeId, prop: u8) -> bool {
    let p = dom(cx).by_id(id);
    // SAFETY: live node data.
    !p.is_null() && unsafe { &(*p).touch }.iter().any(|&(i, _)| i == prop)
}

/// Whether node `id` has any touch handler.
pub(crate) fn listens_to_touches(cx: *mut JsContext, id: NodeId) -> bool {
    let p = dom(cx).by_id(id);
    // SAFETY: live node data.
    !p.is_null() && !unsafe { &(*p).touch }.is_empty()
}

/// Whether node `id` waits for its pan (`panActivation`).
pub(crate) fn pan_gated(cx: *mut JsContext, id: NodeId) -> bool {
    let p = dom(cx).by_id(id);
    // SAFETY: live node data.
    !p.is_null() && unsafe { (*p).pan_gated }
}

/// Whether `node` is `of` or an ancestor of it.
pub(crate) fn is_ancestor_of(cx: *mut JsContext, node: NodeId, of: NodeId) -> bool {
    is_ancestor(cx, node, of)
}

/// `ios={{…}}` / `android={{…}}` / `web={{…}}` / `desktop={{…}}`: the
/// props of this platform only, each set (or cleared) on its own. Desktop
/// props apply on the desktop OSes and in desktop-class browsers.
fn platform_props(
    cx: *mut JsContext,
    node: JsValue,
    name: &str,
    value: JsValue,
    prev: JsValue,
) -> Result<(), JsValue> {
    let dom = dom(cx);
    let applies = match name {
        "desktop" => dom.desktop.get(),
        other => other == dom.os.get().name(),
    };
    if !applies {
        return Ok(());
    }
    // SAFETY: property reads of live values; every value got is freed.
    unsafe {
        let keys = |obj: JsValue| -> Vec<String> {
            let mut out = Vec::new();
            if !qjs::JS_IsObject(obj) {
                return out;
            }
            let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
            let mut len: u32 = 0;
            if qjs::JS_GetOwnPropertyNames(
                cx,
                &mut tab,
                &mut len,
                obj,
                (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_ENUM_ONLY) as c_int,
            ) != 0
            {
                return out;
            }
            for i in 0..len as usize {
                let atom = (*tab.add(i)).atom;
                let s = qjs::JS_AtomToCStringLen(cx, std::ptr::null_mut(), atom);
                if !s.is_null() {
                    out.push(CStr::from_ptr(s).to_string_lossy().into_owned());
                    qjs::JS_FreeCString(cx, s);
                }
            }
            qjs::JS_FreePropertyEnum(cx, tab, len);
            out
        };
        let get = |obj: JsValue, key: &str| -> JsValue {
            if !qjs::JS_IsObject(obj) {
                return UNDEFINED;
            }
            let k = std::ffi::CString::new(key).unwrap_or_default();
            qjs::JS_GetPropertyStr(cx, obj, k.as_ptr())
        };
        let next_keys = keys(value);
        for key in keys(prev) {
            if !next_keys.contains(&key) {
                let old = get(prev, &key);
                let r = set_prop(cx, node, &key, UNDEFINED, old);
                qjs::JS_FreeValue(cx, old);
                r?;
            }
        }
        for key in next_keys {
            let (v, old) = (get(value, &key), get(prev, &key));
            let r = set_prop(cx, node, &key, v, old);
            qjs::JS_FreeValue(cx, v);
            qjs::JS_FreeValue(cx, old);
            r?;
        }
    }
    Ok(())
}

/// `prop(node, name, value)`: a static prop.
unsafe extern "C" fn prop(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(name) = to_string(cx, arg(argc, argv, 1)) else {
        return qjs::JS_EXCEPTION;
    };
    set_prop(cx, arg(argc, argv, 0), &name, arg(argc, argv, 2), UNDEFINED)
        .err()
        .unwrap_or(UNDEFINED)
}

/// A prop `name` of `node` following `get()` (all borrowed).
pub(crate) fn bind_prop_with(
    cx: *mut JsContext,
    node: JsValue,
    name: &str,
    get: JsValue,
) -> Result<(), JsValue> {
    let name = unsafe { qjs::JS_NewStringLen(cx, name.as_ptr().cast(), name.len() as _) };
    let mut args = [node, name, get];
    // SAFETY: borrowed arguments, as `bindProp` takes them.
    let r = unsafe { bind_prop(cx, UNDEFINED, 3, args.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, name) };
    if unsafe { qjs::JS_IsException(r) } {
        Err(r)
    } else {
        Ok(())
    }
}

/// `bindProp(node, name, get)`: a prop following `get()`.
unsafe extern "C" fn bind_prop(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut data = [arg(argc, argv, 0), arg(argc, argv, 1), arg(argc, argv, 2)];
    // SAFETY: the function keeps dups of `data`.
    let func =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(bind_prop_run), 1, 0, 3, data.as_mut_ptr()) };
    let r = reactive::render_effect(cx, func);
    unsafe { qjs::JS_FreeValue(cx, r) };
    reactive::finish_value(cx, UNDEFINED)
}

/// A run of a bound prop: `prev` in, the new value out (kept by the graph).
unsafe extern "C" fn bind_prop_run(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (`bind_prop`).
    let (node, name, get) = unsafe { (*data, *data.add(1), *data.add(2)) };
    let prev = arg(argc, argv, 0);
    let next = unsafe { qjs::JS_Call(cx, get, UNDEFINED, 0, ptr::null_mut()) };
    if unsafe { qjs::JS_IsException(next) } {
        return next;
    }
    if unsafe { qjs::JS_IsStrictEqual(cx, prev, next) } {
        return next;
    }
    let Some(name) = to_string(cx, name) else {
        unsafe { qjs::JS_FreeValue(cx, next) };
        return qjs::JS_EXCEPTION;
    };
    match set_prop(cx, node, &name, next, prev) {
        Ok(()) => next,
        Err(e) => {
            unsafe { qjs::JS_FreeValue(cx, next) };
            e
        }
    }
}

/// `spread(node, props)`: every prop of `props` (an object, possibly with
/// getters), followed.
unsafe extern "C" fn spread(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut data = [arg(argc, argv, 0), arg(argc, argv, 1)];
    // SAFETY: the function keeps dups of `data`.
    let func =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(spread_run), 1, 0, 2, data.as_mut_ptr()) };
    let r = reactive::render_effect(cx, func);
    unsafe { qjs::JS_FreeValue(cx, r) };
    reactive::finish_value(cx, UNDEFINED)
}

/// A run of a spread: the previous values (an object) in, the new ones
/// out.
unsafe extern "C" fn spread_run(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`spread`), three with magic 1
    // (`spread_except`); every value got is freed.
    unsafe {
        let (node, props) = (*data, *data.add(1));
        // A third value: keys to leave out (`spread_except`).
        let skip: Vec<String> = if magic == 1 {
            array_items(cx, *data.add(2))
                .into_iter()
                .map(|k| {
                    let s = to_string(cx, k).unwrap_or_default();
                    qjs::JS_FreeValue(cx, k);
                    s
                })
                .collect()
        } else {
            Vec::new()
        };
        let prev = arg(argc, argv, 0);
        let next = qjs::JS_NewObject(cx);
        let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
        let mut len: u32 = 0;
        if !qjs::JS_IsObject(props)
            || qjs::JS_GetOwnPropertyNames(
                cx,
                &mut tab,
                &mut len,
                props,
                (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_ENUM_ONLY) as c_int,
            ) != 0
        {
            return next;
        }
        let mut failed = None;
        for i in 0..len as usize {
            let atom = (*tab.add(i)).atom;
            let name = qjs::JS_AtomToCStringLen(cx, std::ptr::null_mut(), atom);
            if name.is_null() {
                failed = Some(qjs::JS_EXCEPTION);
                break;
            }
            let name_str = CStr::from_ptr(name).to_string_lossy().into_owned();
            qjs::JS_FreeCString(cx, name);
            // Left-out keys are never read: `children` is a getter that
            // builds the content, which the component renders itself (and a
            // read here would also make this effect track the content).
            if skip.contains(&name_str) {
                continue;
            }
            let v = qjs::JS_GetProperty(cx, props, atom);
            if qjs::JS_IsException(v) {
                failed = Some(v);
                break;
            }
            let old = if qjs::JS_IsObject(prev) {
                qjs::JS_GetProperty(cx, prev, atom)
            } else {
                UNDEFINED
            };
            let r = if qjs::JS_IsStrictEqual(cx, old, v) {
                Ok(())
            } else {
                set_prop(cx, node, &name_str, v, old)
            };
            qjs::JS_FreeValue(cx, old);
            qjs::JS_SetProperty(cx, next, atom, v);
            if let Err(e) = r {
                failed = Some(e);
                break;
            }
        }
        qjs::JS_FreePropertyEnum(cx, tab, len);
        match failed {
            Some(e) => {
                qjs::JS_FreeValue(cx, next);
                e
            }
            None => next,
        }
    }
}

// --- Children -------------------------------------------------------------------

/// What a child value renders as.
enum Item {
    Node(JsValue),
    Text(String),
}

/// Collects what `value` (borrowed) renders as into `out` (node values
/// borrowed from `keep`, which owns what calls returned). Functions are
/// called (tracked by the running computation).
fn resolve(
    cx: *mut JsContext,
    value: JsValue,
    out: &mut Vec<Item>,
    keep: &mut Vec<JsValue>,
    depth: u32,
) -> Result<(), JsValue> {
    if depth > MAX_DEPTH {
        return Err(throw_type(cx, "nsh: children nested too deeply"));
    }
    // SAFETY: inline tag checks and reads of live values; returned values
    // are kept in `keep` (freed by the caller).
    unsafe {
        let tag = qjs::JS_VALUE_GET_TAG(value);
        if tag == qjs::JS_TAG_UNDEFINED || tag == qjs::JS_TAG_NULL || tag == qjs::JS_TAG_BOOL {
            return Ok(());
        }
        if qjs::JS_IsString(value) || qjs::JS_IsNumber(value) || tag == qjs::JS_TAG_BIG_INT {
            let Some(s) = to_string(cx, value) else {
                return Err(qjs::JS_EXCEPTION);
            };
            out.push(Item::Text(s));
            return Ok(());
        }
        if !node_ptr(cx, value).is_null() {
            out.push(Item::Node(value));
            return Ok(());
        }
        if qjs::JS_IsFunction(cx, value) {
            let r = qjs::JS_Call(cx, value, UNDEFINED, 0, ptr::null_mut());
            if qjs::JS_IsException(r) {
                return Err(r);
            }
            keep.push(r);
            return resolve(cx, r, out, keep, depth + 1);
        }
        if qjs::JS_IsArray(value) {
            let mut len: i64 = 0;
            if qjs::JS_GetLength(cx, value, &mut len) != 0 {
                return Err(qjs::JS_EXCEPTION);
            }
            for i in 0..len.max(0) as u32 {
                let item = qjs::JS_GetPropertyUint32(cx, value, i);
                if qjs::JS_IsException(item) {
                    return Err(item);
                }
                keep.push(item);
                resolve(cx, item, out, keep, depth + 1)?;
            }
            return Ok(());
        }
    }
    dom(cx)
        .shared
        .warnings
        .borrow_mut()
        .warn("a child that is not an element, text, array or function is not rendered".into());
    Ok(())
}

/// Turns items into node values (owned): text becomes new text nodes,
/// except a lone text over a lone text node `reuse`, which is updated.
fn materialize(
    cx: *mut JsContext,
    items: Vec<Item>,
    reuse: Option<JsValue>,
) -> Result<Vec<JsValue>, JsValue> {
    let reuse = reuse.filter(|&n| {
        let p = node_ptr(cx, n);
        // SAFETY: live node data.
        !p.is_null() && unsafe { (*p).text }
    });
    if let (Some(node), [Item::Text(_)]) = (reuse, items.as_slice()) {
        let Some(Item::Text(text)) = items.into_iter().next() else {
            unreachable!()
        };
        // SAFETY: a live text node's data.
        let id = unsafe { (*node_ptr(cx, node)).id };
        dom(cx).push(cx, Op::SetText { id, text })?;
        return Ok(vec![unsafe { qjs::JS_DupValue(cx, node) }]);
    }
    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        match item {
            // SAFETY: a dup of a live node.
            Item::Node(v) => nodes.push(unsafe { qjs::JS_DupValue(cx, v) }),
            Item::Text(text) => match text_node(cx, text) {
                Ok(v) => nodes.push(v),
                Err(e) => {
                    free_values(cx, nodes);
                    return Err(e);
                }
            },
        }
    }
    Ok(nodes)
}

fn free_values(cx: *mut JsContext, values: Vec<JsValue>) {
    for v in values {
        // SAFETY: owned values.
        unsafe { qjs::JS_FreeValue(cx, v) };
    }
}

/// Whether `value` holds a function (directly or in nested arrays): its
/// children change over time.
fn is_dynamic(cx: *mut JsContext, value: JsValue, depth: u32) -> bool {
    // SAFETY: inline checks and reads of live values, each freed.
    unsafe {
        if qjs::JS_IsFunction(cx, value) {
            return true;
        }
        if depth > MAX_DEPTH || !qjs::JS_IsArray(value) {
            return false;
        }
        let mut len: i64 = 0;
        if qjs::JS_GetLength(cx, value, &mut len) != 0 {
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            return false;
        }
        for i in 0..len.max(0) as u32 {
            let item = qjs::JS_GetPropertyUint32(cx, value, i);
            let dynamic = is_dynamic(cx, item, depth + 1);
            qjs::JS_FreeValue(cx, item);
            if dynamic {
                return true;
            }
        }
    }
    false
}

/// Inserts `value` (borrowed) into `parent` before `marker`: once for a
/// static value, kept up to date by a render effect for a dynamic one.
fn insert_value(
    cx: *mut JsContext,
    parent: JsValue,
    value: JsValue,
    marker: Option<JsValue>,
) -> Result<(), JsValue> {
    if is_dynamic(cx, value, 0) {
        // What the insert shows now, which its effects update.
        let shown = new_array(cx, Vec::new());
        let r = if unsafe { qjs::JS_IsFunction(cx, value) } {
            insert_effect(
                cx,
                insert_run,
                [parent, marker.unwrap_or(UNDEFINED), value, shown],
            )
        } else {
            insert_items(cx, parent, marker.unwrap_or(UNDEFINED), value, shown)
        };
        unsafe { qjs::JS_FreeValue(cx, shown) };
        r?;
        // A throw in the effect is the round's error.
        let r = reactive::finish_value(cx, UNDEFINED);
        return if unsafe { qjs::JS_IsException(r) } {
            Err(r)
        } else {
            Ok(())
        };
    }
    let mut items = Vec::new();
    let mut keep = Vec::new();
    let resolved = resolve(cx, value, &mut items, &mut keep, 0);
    let result = resolved.and_then(|()| {
        let nodes = materialize(cx, items, None)?;
        let mut result = Ok(());
        for &n in &nodes {
            result = insert_before(cx, parent, n, marker);
            if result.is_err() {
                break;
            }
        }
        free_values(cx, nodes);
        result
    });
    free_values(cx, keep);
    result
}

/// A render effect of an insert running `run` with `data` (borrowed:
/// the parent, the marker, the value and the array of the nodes shown).
fn insert_effect(
    cx: *mut JsContext,
    run: unsafe extern "C" fn(
        *mut JsContext,
        JsValue,
        c_int,
        *mut JsValue,
        c_int,
        *mut JsValue,
    ) -> JsValue,
    mut data: [JsValue; 4],
) -> Result<(), JsValue> {
    // SAFETY: the function keeps dups of `data`.
    let func = unsafe { qjs::JS_NewCFunctionData(cx, Some(run), 0, 0, 4, data.as_mut_ptr()) };
    if unsafe { qjs::JS_IsException(func) } {
        return Err(func);
    }
    let r = reactive::render_effect(cx, func);
    unsafe { qjs::JS_FreeValue(cx, r) };
    Ok(())
}

/// The insert of an array holding functions (`items`, borrowed): each
/// function gets a memo of its own, so a change in one runs only that one
/// and the others' nodes stay (not made again), and one render effect
/// shows them all.
fn insert_items(
    cx: *mut JsContext,
    parent: JsValue,
    marker: JsValue,
    items: JsValue,
    shown: JsValue,
) -> Result<(), JsValue> {
    let memos = memoize_run(cx, items);
    let r = insert_effect(
        cx,
        insert_items_run,
        [parent, marker, memos.unwrap_or(items), shown],
    );
    if let Some(memos) = memos {
        unsafe { qjs::JS_FreeValue(cx, memos) };
    }
    r
}

/// For an array of children holding functions, a copy with a memo for each
/// function (owned), made under the running owner; `None` otherwise.
fn memoize_run(cx: *mut JsContext, value: JsValue) -> Option<JsValue> {
    // SAFETY: reads of a live value.
    if unsafe { !qjs::JS_IsArray(value) } {
        return None;
    }
    let items = array_items(cx, value);
    // SAFETY: borrowed values checked.
    let functions = items
        .iter()
        .filter(|&&v| unsafe { qjs::JS_IsFunction(cx, v) } && node_ptr(cx, v).is_null())
        .count();
    if items.len() < 2 || functions == 0 {
        free_values(cx, items);
        return None;
    }
    let items = items
        .into_iter()
        .map(|v| {
            // SAFETY: a borrowed check of an owned value.
            if unsafe { qjs::JS_IsFunction(cx, v) } && node_ptr(cx, v).is_null() {
                item_memo(cx, v)
            } else {
                v
            }
        })
        .collect();
    Some(new_array(cx, items))
}

/// A memo of a child function `func` (owned), including the functions it
/// returns, made under the running owner (owned; an exception when it throws).
pub(crate) fn item_memo(cx: *mut JsContext, func: JsValue) -> JsValue {
    let mut data = [func];
    // SAFETY: the function keeps a dup of `func`, which is then freed.
    let run = unsafe { qjs::JS_NewCFunctionData(cx, Some(item_run), 0, 0, 1, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, func) };
    if unsafe { qjs::JS_IsException(run) } {
        return run;
    }
    // The memo takes the function.
    reactive::memo(cx, run, false)
}

/// A run of an [`item_memo`]: calls its function, and gives a function it
/// returns (an `<If>` whose branch is an expression returns one) a memo of
/// its own, under this one. Called by the array's effect instead, that
/// function would run again, and make its nodes again, whenever any other
/// item of the array changes; called by this memo, a change in what it
/// reads would run this function again too (a component's `children`
/// getter: the component made again).
unsafe extern "C" fn item_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`item_memo`).
    let r = unsafe { qjs::JS_Call(cx, *data, UNDEFINED, 0, ptr::null_mut()) };
    // SAFETY: inline checks of a live value.
    if unsafe { !qjs::JS_IsException(r) && qjs::JS_IsFunction(cx, r) } && node_ptr(cx, r).is_null()
    {
        return item_memo(cx, r);
    }
    r
}

/// `insert(parent, value, marker)`: children before `marker` (or at the
/// end).
unsafe extern "C" fn insert(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let marker = arg(argc, argv, 2);
    let marker = (!node_ptr(cx, marker).is_null()).then_some(marker);
    insert_value(cx, arg(argc, argv, 0), arg(argc, argv, 1), marker)
        .err()
        .unwrap_or(UNDEFINED)
}

/// The values of array `array` (owned), empty for other values.
fn array_items(cx: *mut JsContext, array: JsValue) -> Vec<JsValue> {
    let mut out = Vec::new();
    // SAFETY: reads of a live array.
    unsafe {
        if !qjs::JS_IsArray(array) {
            return out;
        }
        let mut len: i64 = 0;
        if qjs::JS_GetLength(cx, array, &mut len) != 0 {
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            return out;
        }
        for i in 0..len.max(0) as u32 {
            out.push(qjs::JS_GetPropertyUint32(cx, array, i));
        }
    }
    out
}

/// A new array of `values` (taken).
fn new_array(cx: *mut JsContext, mut values: Vec<JsValue>) -> JsValue {
    // SAFETY: the array takes the values.
    unsafe { qjs::JS_NewArrayFrom(cx, values.len() as c_int, values.as_mut_ptr()) }
}

/// A run of a dynamic insert of a function: calls it, and the functions it
/// returns, tracked by this effect. An array holding functions gets an
/// effect of its own ([`insert_items`]), made again only when this one
/// runs again: a component's `children` getter makes every node of the
/// array, and a change in one of its functions (an `<If>`, a ternary)
/// must run only that one, not the getter.
unsafe extern "C" fn insert_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: four data values (`insert_effect`).
    let (parent, marker, value, shown) =
        unsafe { (*data, *data.add(1), *data.add(2), *data.add(3)) };
    // SAFETY: a dup of a live value; each call's result replaces it.
    let mut value = unsafe { qjs::JS_DupValue(cx, value) };
    let mut depth = 0;
    while unsafe { qjs::JS_IsFunction(cx, value) } && node_ptr(cx, value).is_null() {
        if depth > MAX_DEPTH {
            unsafe { qjs::JS_FreeValue(cx, value) };
            return throw_type(cx, "nsh: children nested too deeply");
        }
        let r = unsafe { qjs::JS_Call(cx, value, UNDEFINED, 0, ptr::null_mut()) };
        unsafe { qjs::JS_FreeValue(cx, value) };
        if unsafe { qjs::JS_IsException(r) } {
            return r;
        }
        value = r;
        depth += 1;
    }
    let r = if unsafe { qjs::JS_IsArray(value) } && is_dynamic(cx, value, 0) {
        insert_items(cx, parent, marker, value, shown)
    } else {
        show(cx, parent, marker, value, shown)
    };
    unsafe { qjs::JS_FreeValue(cx, value) };
    r.err().unwrap_or(UNDEFINED)
}

/// A run of the effect of [`insert_items`]: shows the array, its functions
/// called (tracked by this effect).
unsafe extern "C" fn insert_items_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: four data values (`insert_effect`).
    let (parent, marker, items, shown) =
        unsafe { (*data, *data.add(1), *data.add(2), *data.add(3)) };
    show(cx, parent, marker, items, shown)
        .err()
        .unwrap_or(UNDEFINED)
}

/// Shows `value` (borrowed; its functions are called) in `parent` before
/// `marker` in place of the nodes `shown` holds, which then holds the new
/// ones.
fn show(
    cx: *mut JsContext,
    parent: JsValue,
    marker: JsValue,
    value: JsValue,
    shown: JsValue,
) -> Result<(), JsValue> {
    let marker = (!node_ptr(cx, marker).is_null()).then_some(marker);
    let mut items = Vec::new();
    let mut keep = Vec::new();
    if let Err(e) = resolve(cx, value, &mut items, &mut keep, 0) {
        free_values(cx, keep);
        return Err(e);
    }
    let old = array_items(cx, shown);
    // A lone text node shown again as text is updated in place.
    let reuse = match old.as_slice() {
        [only] => Some(*only),
        _ => None,
    };
    let lone_text = matches!(items.as_slice(), [Item::Text(_)]);
    let new = match materialize(cx, items, reuse.filter(|_| lone_text)) {
        Ok(new) => new,
        Err(e) => {
            free_values(cx, keep);
            free_values(cx, old);
            return Err(e);
        }
    };
    free_values(cx, keep);
    let result = reconcile(cx, parent, &old, &new, marker);
    // The old nodes are freed after the reconcile: a node it removes stays
    // alive until then.
    free_values(cx, old);
    match result {
        Ok(()) => {
            set_shown(cx, shown, new);
            Ok(())
        }
        Err(e) => {
            free_values(cx, new);
            Err(e)
        }
    }
}

/// Makes array `shown` hold `nodes` (taken) alone.
fn set_shown(cx: *mut JsContext, shown: JsValue, nodes: Vec<JsValue>) {
    // SAFETY: writes to a live array, which takes the values.
    unsafe {
        let len = qjs::JS_NewFloat64(0.0);
        qjs::JS_SetPropertyStr(cx, shown, c"length".as_ptr(), len);
        for (i, node) in nodes.into_iter().enumerate() {
            qjs::JS_SetPropertyUint32(cx, shown, i as u32, node);
        }
    }
}

/// Solid's `reconcileArrays`: changes `parent`'s children from `old` to
/// `new` (the nodes of one insert, before `marker`) with few moves.
fn reconcile(
    cx: *mut JsContext,
    parent: JsValue,
    old: &[JsValue],
    new: &[JsValue],
    marker: Option<JsValue>,
) -> Result<(), JsValue> {
    let mut a: Vec<JsValue> = old.to_vec();
    let b = new;
    let b_len = b.len();
    let (mut a_start, mut b_start) = (0usize, 0usize);
    let (mut a_end, mut b_end) = (a.len(), b_len);
    let after = match a.last() {
        Some(&last) => next_sibling(cx, last).or(marker),
        None => marker,
    };
    let mut map: Option<FxHashMap<usize, usize>> = None;
    while a_start < a_end || b_start < b_end {
        if a_start < a_end && b_start < b_end && same(a[a_start], b[b_start]) {
            a_start += 1;
            b_start += 1;
            continue;
        }
        while a_end > a_start && b_end > b_start && same(a[a_end - 1], b[b_end - 1]) {
            a_end -= 1;
            b_end -= 1;
        }
        if a_end == a_start {
            // Appends, before the first node of the placed tail. (Solid
            // takes the sibling after `b[b_start - 1]`, but a node kept
            // in place below can sit there.)
            let node = if b_end < b_len { Some(b[b_end]) } else { after };
            while b_start < b_end {
                insert_before(cx, parent, b[b_start], node)?;
                b_start += 1;
            }
        } else if b_end == b_start {
            // Removals.
            while a_start < a_end {
                if map
                    .as_ref()
                    .is_none_or(|m| !m.contains_key(&ptr_of(a[a_start])))
                {
                    remove_child(cx, parent, a[a_start])?;
                }
                a_start += 1;
            }
        } else if same(a[a_start], b[b_end - 1]) && same(b[b_start], a[a_end - 1]) {
            // A swap.
            a_end -= 1;
            let node = next_sibling(cx, a[a_end]);
            let first_next = next_sibling(cx, a[a_start]);
            insert_before(cx, parent, b[b_start], first_next)?;
            b_start += 1;
            a_start += 1;
            b_end -= 1;
            insert_before(cx, parent, b[b_end], node)?;
            a[a_end] = b[b_end];
        } else {
            let map =
                map.get_or_insert_with(|| (b_start..b_end).map(|i| (ptr_of(b[i]), i)).collect());
            match map.get(&ptr_of(a[a_start])).copied() {
                Some(index) if b_start < index && index < b_end => {
                    let mut i = a_start;
                    let mut sequence = 1;
                    loop {
                        i += 1;
                        if !(i < a_end && i < b_end) {
                            break;
                        }
                        match map.get(&ptr_of(a[i])) {
                            Some(&t) if t == index + sequence => sequence += 1,
                            _ => break,
                        }
                    }
                    if sequence > index - b_start {
                        let node = a[a_start];
                        while b_start < index {
                            insert_before(cx, parent, b[b_start], Some(node))?;
                            b_start += 1;
                        }
                    } else {
                        // Replaces a[a_start] with b[b_start]; a node that
                        // comes again later stays (it is moved then, not
                        // removed and inserted: the core would remake its
                        // view).
                        insert_before(cx, parent, b[b_start], Some(a[a_start]))?;
                        if !map.contains_key(&ptr_of(a[a_start])) {
                            remove_child(cx, parent, a[a_start])?;
                        }
                        b_start += 1;
                        a_start += 1;
                    }
                }
                Some(_) => a_start += 1,
                None => {
                    remove_child(cx, parent, a[a_start])?;
                    a_start += 1;
                }
            }
        }
    }
    Ok(())
}

// --- Components and control flow ------------------------------------------------

/// `merge(...sources)`: a new object with the own enumerable properties of
/// each source, later ones winning; getters stay getters (props spread
/// into a component stay live).
unsafe extern "C" fn merge(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: property reads and definitions on live objects; descriptor
    // values are freed after use.
    unsafe {
        let target = qjs::JS_NewObject(cx);
        for i in 0..argc.max(0) as usize {
            let source = *argv.add(i);
            if !qjs::JS_IsObject(source) {
                continue;
            }
            let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
            let mut len: u32 = 0;
            if qjs::JS_GetOwnPropertyNames(
                cx,
                &mut tab,
                &mut len,
                source,
                (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_SYMBOL_MASK | qjs::JS_GPN_ENUM_ONLY)
                    as c_int,
            ) != 0
            {
                qjs::JS_FreeValue(cx, target);
                return qjs::JS_EXCEPTION;
            }
            for j in 0..len as usize {
                copy_property(cx, target, source, (*tab.add(j)).atom);
            }
            qjs::JS_FreePropertyEnum(cx, tab, len);
        }
        target
    }
}

/// Defines `source`'s own property `atom` on `target` as it is: a getter
/// stays a getter (props keep following what they read).
///
/// # Safety
///
/// Live objects and atom.
unsafe fn copy_property(cx: *mut JsContext, target: JsValue, source: JsValue, atom: qjs::JSAtom) {
    // SAFETY: per the contract; descriptor values are freed after use.
    unsafe {
        let mut desc = qjs::JSPropertyDescriptor {
            flags: 0,
            value: UNDEFINED,
            getter: UNDEFINED,
            setter: UNDEFINED,
        };
        if qjs::JS_GetOwnProperty(cx, &mut desc, source, atom) <= 0 {
            return;
        }
        let flags = if desc.flags & qjs::JS_PROP_GETSET as c_int != 0 {
            qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_SET
        } else {
            qjs::JS_PROP_HAS_VALUE | qjs::JS_PROP_HAS_WRITABLE | qjs::JS_PROP_WRITABLE
        } | qjs::JS_PROP_HAS_ENUMERABLE
            | qjs::JS_PROP_ENUMERABLE
            | qjs::JS_PROP_HAS_CONFIGURABLE
            | qjs::JS_PROP_CONFIGURABLE;
        qjs::JS_DefineProperty(
            cx,
            target,
            atom,
            desc.value,
            desc.getter,
            desc.setter,
            flags as c_int,
        );
        qjs::JS_FreeValue(cx, desc.value);
        qjs::JS_FreeValue(cx, desc.getter);
        qjs::JS_FreeValue(cx, desc.setter);
    }
}

/// `split(props, keys)`: `[picked, rest]`, the props named in `keys` and
/// the others, getters kept (a component passing the rest on).
pub(crate) unsafe extern "C" fn split(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (source, keys) = (arg(argc, argv, 0), arg(argc, argv, 1));
    // SAFETY: reads and definitions on live objects; what is made is
    // returned or freed.
    unsafe {
        let mut names = Vec::new();
        if qjs::JS_IsArray(keys) {
            let mut n: i64 = 0;
            qjs::JS_GetLength(cx, keys, &mut n);
            for i in 0..n.max(0) {
                let k = qjs::JS_GetPropertyInt64(cx, keys, i);
                let atom = qjs::JS_ValueToAtom(cx, k);
                qjs::JS_FreeValue(cx, k);
                names.push(atom);
            }
        }
        let picked = qjs::JS_NewObject(cx);
        let rest = qjs::JS_NewObject(cx);
        if qjs::JS_IsObject(source) {
            let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
            let mut len: u32 = 0;
            let flags = (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_SYMBOL_MASK | qjs::JS_GPN_ENUM_ONLY)
                as c_int;
            if qjs::JS_GetOwnPropertyNames(cx, &mut tab, &mut len, source, flags) == 0 {
                for j in 0..len as usize {
                    let atom = (*tab.add(j)).atom;
                    let target = if names.contains(&atom) { picked } else { rest };
                    copy_property(cx, target, source, atom);
                }
                qjs::JS_FreePropertyEnum(cx, tab, len);
            }
        }
        for atom in names {
            qjs::JS_FreeAtom(cx, atom);
        }
        let mut items = [picked, rest];
        qjs::JS_NewArrayFrom(cx, 2, items.as_mut_ptr())
    }
}

/// `component(Comp, props)`: renders a component (untracked).
unsafe extern "C" fn component(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (comp, props) = (arg(argc, argv, 0), arg(argc, argv, 1));
    let mut args = [props];
    // SAFETY: a borrowed function and argument.
    reactive::untracked_with(cx, || unsafe {
        qjs::JS_Call(cx, comp, UNDEFINED, 1, args.as_mut_ptr())
    })
}

/// `cond(when, then, otherwise)`: what `then()` renders while `when()` is
/// truthy, else what `otherwise()` renders (each branch rendered once per
/// change of truthiness, under its own owner).
unsafe extern "C" fn cond(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: dups the memos and functions own.
    let when = unsafe { qjs::JS_DupValue(cx, arg(argc, argv, 0)) };
    let condition = reactive::memo(cx, when, true);
    let mut data = [condition, arg(argc, argv, 1), arg(argc, argv, 2)];
    let func = unsafe { qjs::JS_NewCFunctionData(cx, Some(cond_run), 0, 0, 3, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, condition) };
    let branch = reactive::memo(cx, func, false);
    reactive::finish_value(cx, branch)
}

/// `cond(when, then)` (borrowed values): `then()` while `when()` is truthy,
/// nothing otherwise (owned; an exception value when it throws).
pub(crate) fn cond_value(cx: *mut JsContext, when: JsValue, then: JsValue) -> JsValue {
    let mut args = [when, then, UNDEFINED];
    // SAFETY: borrowed arguments, as `cond` takes them.
    unsafe { cond(cx, UNDEFINED, 3, args.as_mut_ptr()) }
}

unsafe extern "C" fn cond_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (`cond`).
    let (condition, then, otherwise) = unsafe { (*data, *data.add(1), *data.add(2)) };
    let c = unsafe { qjs::JS_Call(cx, condition, UNDEFINED, 0, ptr::null_mut()) };
    if unsafe { qjs::JS_IsException(c) } {
        return c;
    }
    let truthy = unsafe { qjs::JS_ToBool(cx, c) } == 1;
    unsafe { qjs::JS_FreeValue(cx, c) };
    let branch = if truthy { then } else { otherwise };
    if !unsafe { qjs::JS_IsFunction(cx, branch) } {
        return UNDEFINED;
    }
    reactive::untracked_with(cx, || unsafe {
        qjs::JS_Call(cx, branch, UNDEFINED, 0, ptr::null_mut())
    })
}

/// A key rows are matched by: objects by identity, primitives by value.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Key {
    Object(usize),
    Text(Box<str>),
    Number(u64),
    Other(i32, i64),
}

impl Key {
    fn of(cx: *mut JsContext, v: JsValue) -> Key {
        // SAFETY: inline reads of a live value.
        unsafe {
            let tag = qjs::JS_VALUE_GET_TAG(v);
            if tag == qjs::JS_TAG_OBJECT {
                Key::Object(ptr_of(v))
            } else if qjs::JS_IsString(v) {
                Key::Text(to_string(cx, v).unwrap_or_default().into())
            } else if qjs::JS_IsNumber(v) {
                let mut n = 0f64;
                qjs::JS_ToFloat64(cx, &mut n, v);
                // SameValueZero: -0 is 0, NaN is NaN.
                let n = if n == 0.0 {
                    0.0
                } else if n.is_nan() {
                    f64::NAN
                } else {
                    n
                };
                Key::Number(n.to_bits())
            } else {
                Key::Other(tag, qjs::JS_VALUE_GET_INT(v) as i64)
            }
        }
    }
}

/// A row of `each`.
struct Row {
    key: Key,
    /// The key value (owned: an object key stays alive while it names the
    /// row).
    key_value: JsValue,
    /// Signals of the row's item and index (owned).
    item: JsValue,
    index: JsValue,
    /// The row's owner.
    owner: u32,
    /// What the row rendered (owned).
    output: JsValue,
}

#[derive(Default)]
struct EachData {
    rows: Vec<Row>,
}

unsafe extern "C" fn each_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of an each object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut EachData;
    if p.is_null() {
        return;
    }
    let data = unsafe { Box::from_raw(p) };
    for row in data.rows {
        for v in [row.key_value, row.item, row.index, row.output] {
            unsafe { qjs::JS_FreeValueRT(rt, v) };
        }
    }
}

unsafe extern "C" fn each_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer; marking reads only.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const EachData;
    if p.is_null() {
        return;
    }
    for row in unsafe { &(*p).rows } {
        for v in [row.key_value, row.item, row.index, row.output] {
            unsafe { qjs::JS_MarkValue(rt, v, mark) };
        }
    }
}

/// `each(list, render, key)`: `render(item, index)` for each item of
/// `list()` (both accessors), one row per key (`key(item, index)`, the
/// index for `key` `"index"`, or the item itself) kept while the key
/// stays.
pub(crate) unsafe extern "C" fn each(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: a new object of the each class owning its boxed data.
    let rows = unsafe {
        let obj = qjs::JS_NewObjectClass(cx, dom(cx).classes.each as _);
        qjs::JS_SetOpaque(
            obj,
            Box::into_raw(Box::<EachData>::default()) as *mut c_void,
        );
        obj
    };
    // The rows go with the owner `each` is called under.
    let mut cleanup_data = [rows];
    let cleanup = unsafe {
        qjs::JS_NewCFunctionData(cx, Some(each_dispose), 0, 0, 1, cleanup_data.as_mut_ptr())
    };
    let mut args = [cleanup];
    let r = unsafe { reactive::on_cleanup(cx, UNDEFINED, 1, args.as_mut_ptr()) };
    unsafe {
        qjs::JS_FreeValue(cx, r);
        qjs::JS_FreeValue(cx, cleanup);
    }
    let mut data = [
        arg(argc, argv, 0),
        arg(argc, argv, 1),
        arg(argc, argv, 2),
        rows,
    ];
    let func = unsafe { qjs::JS_NewCFunctionData(cx, Some(each_run), 0, 0, 4, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, rows) };
    let memo = reactive::memo(cx, func, false);
    reactive::finish_value(cx, memo)
}

fn each_data(cx: *mut JsContext, rows: JsValue) -> *mut EachData {
    // SAFETY: the opaque of an each object.
    unsafe { qjs::JS_GetOpaque(rows, dom(cx).classes.each) as *mut EachData }
}

/// Disposes a row (taken).
fn dispose_row(cx: *mut JsContext, row: Row) {
    reactive::dispose_owner(cx, row.owner);
    for v in [row.key_value, row.item, row.index, row.output] {
        // SAFETY: values the row owned.
        unsafe { qjs::JS_FreeValue(cx, v) };
    }
}

unsafe extern "C" fn each_dispose(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`each`).
    let p = each_data(cx, unsafe { *data });
    if !p.is_null() {
        let rows = std::mem::take(unsafe { &mut (*p).rows });
        for row in rows {
            dispose_row(cx, row);
        }
    }
    UNDEFINED
}

unsafe extern "C" fn each_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: four data values (`each`).
    let (list, render, key_fn, rows) = unsafe { (*data, *data.add(1), *data.add(2), *data.add(3)) };
    let items = unsafe { qjs::JS_Call(cx, list, UNDEFINED, 0, ptr::null_mut()) };
    if unsafe { qjs::JS_IsException(items) } {
        return items;
    }
    let items_v = array_items(cx, items);
    unsafe { qjs::JS_FreeValue(cx, items) };
    let keyed = unsafe { qjs::JS_IsFunction(cx, key_fn) };
    // SAFETY: a borrowed value, read when it is a string.
    let by_index = !keyed
        && unsafe { qjs::JS_IsString(key_fn) }
        && to_string(cx, key_fn).as_deref() == Some("index");
    let result = reactive::untracked_with(cx, || {
        let p = each_data(cx, rows);
        let old = std::mem::take(unsafe { &mut (*p).rows });
        let mut old: Vec<Option<Row>> = old.into_iter().map(Some).collect();
        let mut by_key: FxHashMap<Key, Vec<usize>> = FxHashMap::default();
        for (i, row) in old.iter().enumerate().rev() {
            let row = row.as_ref().expect("all present");
            by_key.entry(row.key.clone()).or_default().push(i);
        }
        let mut new_rows = Vec::with_capacity(items_v.len());
        let mut failed = None;
        for (i, &item) in items_v.iter().enumerate() {
            // SAFETY: calls of borrowed functions with live values; the
            // values got are owned by the row or freed.
            let key_value = if by_index {
                qjs::JS_NewFloat64(i as f64)
            } else if keyed {
                let mut args = [item, qjs::JS_NewFloat64(i as f64)];
                let k = unsafe { qjs::JS_Call(cx, key_fn, UNDEFINED, 2, args.as_mut_ptr()) };
                if unsafe { qjs::JS_IsException(k) } {
                    failed = Some(k);
                    break;
                }
                k
            } else {
                unsafe { qjs::JS_DupValue(cx, item) }
            };
            let key = Key::of(cx, key_value);
            let reused = by_key
                .get_mut(&key)
                .and_then(|v| v.pop())
                .and_then(|at| old[at].take());
            match reused {
                Some(row) => {
                    unsafe { qjs::JS_FreeValue(cx, key_value) };
                    if !unsafe { qjs::JS_IsStrictEqual(cx, reactive::peek(cx, row.item), item) } {
                        reactive::set_signal(cx, row.item, unsafe { qjs::JS_DupValue(cx, item) });
                    }
                    let index = qjs::JS_NewFloat64(i as f64);
                    if !unsafe { qjs::JS_IsStrictEqual(cx, reactive::peek(cx, row.index), index) } {
                        reactive::set_signal(cx, row.index, index);
                    }
                    new_rows.push(row);
                }
                None => {
                    let item_signal = reactive::new_signal(cx, item);
                    let index_signal = reactive::new_signal(cx, qjs::JS_NewFloat64(i as f64));
                    let (owner, output) = reactive::with_root(cx, || {
                        let mut args = [item_signal, index_signal];
                        unsafe { qjs::JS_Call(cx, render, UNDEFINED, 2, args.as_mut_ptr()) }
                    });
                    let row = Row {
                        key,
                        key_value,
                        item: item_signal,
                        index: index_signal,
                        owner,
                        output: UNDEFINED,
                    };
                    if unsafe { qjs::JS_IsException(output) } {
                        dispose_row(cx, row);
                        failed = Some(output);
                        break;
                    }
                    new_rows.push(Row { output, ..row });
                }
            }
        }
        for row in old.into_iter().flatten() {
            dispose_row(cx, row);
        }
        let outputs: Vec<JsValue> = new_rows
            .iter()
            // SAFETY: dups for the returned array.
            .map(|r| unsafe { qjs::JS_DupValue(cx, r.output) })
            .collect();
        let p = each_data(cx, rows);
        unsafe { (*p).rows = new_rows };
        match failed {
            Some(e) => {
                free_values(cx, outputs);
                e
            }
            None => new_array(cx, outputs),
        }
    });
    free_values(cx, items_v);
    result
}

// --- Context ----------------------------------------------------------------------

/// A context's default value (owned).
struct ContextData {
    default: JsValue,
}

unsafe extern "C" fn context_finalize(rt: *mut qjs::JSRuntime, obj: JsValue) {
    // SAFETY: the opaque of a context object is its boxed data.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *mut ContextData;
    if !p.is_null() {
        let data = unsafe { Box::from_raw(p) };
        unsafe { qjs::JS_FreeValueRT(rt, data.default) };
    }
}

unsafe extern "C" fn context_mark(rt: *mut qjs::JSRuntime, obj: JsValue, mark: qjs::JS_MarkFunc) {
    // SAFETY: as in the finalizer.
    let p = unsafe { qjs::JS_GetOpaque(obj, qjs::JS_GetClassID(obj)) } as *const ContextData;
    if !p.is_null() {
        unsafe { qjs::JS_MarkValue(rt, (*p).default, mark) };
    }
}

/// Calling a context: its nearest provided value, else the default.
unsafe extern "C" fn context_call(
    cx: *mut JsContext,
    func: JsValue,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _flags: c_int,
) -> JsValue {
    if let Some(v) = reactive::lookup(cx, func) {
        return v;
    }
    // SAFETY: the opaque of a context object.
    let p = unsafe { qjs::JS_GetOpaque(func, dom(cx).classes.context) } as *const ContextData;
    if p.is_null() {
        return UNDEFINED;
    }
    unsafe { qjs::JS_DupValue(cx, (*p).default) }
}

/// Gives context `kept` the default of context `from` (development
/// updates keep a context's identity).
pub(crate) fn set_context_default(cx: *mut JsContext, kept: JsValue, from: JsValue) {
    let class = dom(cx).classes.context;
    // SAFETY: the opaques of context objects; the old default is freed.
    unsafe {
        let (k, f) = (
            qjs::JS_GetOpaque(kept, class) as *mut ContextData,
            qjs::JS_GetOpaque(from, class) as *const ContextData,
        );
        if k.is_null() || f.is_null() || std::ptr::eq(k, f) {
            return;
        }
        let old = std::mem::replace(&mut (*k).default, qjs::JS_DupValue(cx, (*f).default));
        qjs::JS_FreeValue(cx, old);
    }
}

/// `context(default)`: a context, read by calling it; `<Ctx.Provider
/// value={…}>` provides a value to what it renders.
pub(crate) unsafe extern "C" fn context(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: a new object of the context class owning its boxed data; the
    // provider function keeps a dup of it.
    unsafe {
        let obj = qjs::JS_NewObjectClass(cx, dom(cx).classes.context as _);
        let data = Box::new(ContextData {
            default: qjs::JS_DupValue(cx, arg(argc, argv, 0)),
        });
        qjs::JS_SetOpaque(obj, Box::into_raw(data) as *mut c_void);
        let mut fdata = [obj];
        let provider = qjs::JS_NewCFunctionData(cx, Some(provider), 1, 0, 1, fdata.as_mut_ptr());
        qjs::JS_SetPropertyStr(cx, obj, c"Provider".as_ptr(), provider);
        obj
    }
}

/// A provider component: `{ value, children }`.
unsafe extern "C" fn provider(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`context`); the function keeps dups.
    let mut fdata = [unsafe { *data }, arg(argc, argv, 0)];
    let func =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(provider_run), 0, 0, 2, fdata.as_mut_ptr()) };
    let rendered = reactive::render_effect(cx, func);
    reactive::finish_value(cx, rendered)
}

/// The provider's owner: sets the value, then renders the children in a
/// memo under it (so functions among them run with the value in reach).
unsafe extern "C" fn provider_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`provider`); values got are freed.
    let (key, props) = unsafe { (*data, *data.add(1)) };
    reactive::untracked_with(cx, || unsafe {
        let value = qjs::JS_GetPropertyStr(cx, props, c"value".as_ptr());
        if qjs::JS_IsException(value) {
            return value;
        }
        reactive::provide(cx, key, value);
        qjs::JS_FreeValue(cx, value);
        let children = qjs::JS_GetPropertyStr(cx, props, c"children".as_ptr());
        if qjs::JS_IsException(children) {
            return children;
        }
        let mut fdata = [children];
        let func = qjs::JS_NewCFunctionData(cx, Some(children_run), 0, 0, 1, fdata.as_mut_ptr());
        qjs::JS_FreeValue(cx, children);
        reactive::memo(cx, func, false)
    })
}

/// Unwraps children: functions called (tracked), arrays flattened.
unsafe extern "C" fn children_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value.
    let children = unsafe { *data };
    let mut items = Vec::new();
    let mut keep = Vec::new();
    let resolved = resolve(cx, children, &mut items, &mut keep, 0);
    // Text stays text (the insert makes its nodes); nodes are kept.
    let out = resolved.map(|()| {
        items
            .into_iter()
            .map(|item| match item {
                // SAFETY: a dup for the array.
                Item::Node(v) => unsafe { qjs::JS_DupValue(cx, v) },
                Item::Text(t) => unsafe {
                    qjs::JS_NewStringLen(cx, t.as_ptr().cast(), t.len() as _)
                },
            })
            .collect::<Vec<_>>()
    });
    free_values(cx, keep);
    match out {
        Ok(values) => new_array(cx, values),
        Err(e) => e,
    }
}

// --- Mounting -----------------------------------------------------------------------

/// `mount(App, props)`: renders `App` into the surface; returns a function
/// that removes it.
pub(crate) unsafe extern "C" fn mount(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let d = dom(cx);
    if d.rtl.get().is_none() {
        d.send_direction();
    }
    let (app, props) = (arg(argc, argv, 0), arg(argc, argv, 1));
    // A hot update running the module again keeps what it mounted.
    if let Some(dispose) = crate::hot::reuse(cx, app, props) {
        return dispose;
    }
    let root = d.root.get();
    // SAFETY: reads of the root's children; dups for the dispose function.
    let before: Vec<JsValue> = unsafe { &(*node_ptr(cx, root)).children }
        .iter()
        .map(|&v| unsafe { qjs::JS_DupValue(cx, v) })
        .collect();
    let (owner, result) = reactive::with_root(cx, || {
        let props = if unsafe { qjs::JS_IsObject(props) } {
            unsafe { qjs::JS_DupValue(cx, props) }
        } else {
            unsafe { qjs::JS_NewObject(cx) }
        };
        let mut args = [props];
        let out = reactive::untracked_with(cx, || unsafe {
            qjs::JS_Call(cx, app, UNDEFINED, 1, args.as_mut_ptr())
        });
        unsafe { qjs::JS_FreeValue(cx, props) };
        if unsafe { qjs::JS_IsException(out) } {
            return Err(out);
        }
        let r = insert_value(cx, root, out, None);
        unsafe { qjs::JS_FreeValue(cx, out) };
        r
    });
    if let Err(e) = result {
        free_values(cx, before);
        reactive::dispose_owner(cx, owner);
        return e;
    }
    let mut data = [qjs::JS_NewFloat64(owner as f64), new_array(cx, before)];
    // SAFETY: the function keeps dups of `data`.
    let dispose =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(unmount), 0, 0, 2, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, data[1]) };
    crate::hot::rendered(cx, app, dispose);
    reactive::finish_value(cx, dispose)
}

unsafe extern "C" fn unmount(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`mount`).
    let (owner, before) = unsafe { (*data, *data.add(1)) };
    let mut id = 0f64;
    unsafe { qjs::JS_ToFloat64(cx, &mut id, owner) };
    reactive::dispose_owner(cx, id as u32);
    let before = array_items(cx, before);
    let root = dom(cx).root.get();
    let current: Vec<JsValue> = unsafe { &(*node_ptr(cx, root)).children }
        .iter()
        .map(|&v| unsafe { qjs::JS_DupValue(cx, v) })
        .collect();
    let mut result = UNDEFINED;
    for &c in &current {
        if !before.iter().any(|&b| same(b, c))
            && let Err(e) = remove_child(cx, root, c)
        {
            result = e;
            break;
        }
    }
    free_values(cx, current);
    free_values(cx, before);
    result
}

/// `setup(tailwind, theme, appearance, statusBar)`: the app's Tailwind
/// theme and the theme of the Rust components (JSON strings, or null), its
/// appearance (`"light"` / `"dark"`, or null) and the status bar's default
/// (`nsh.json` `"statusBar"` as JSON, or null), before anything renders.
unsafe extern "C" fn setup(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let root = dom(cx).root.get();
    for (i, name) in ["tailwindTheme", "uiTheme"].into_iter().enumerate() {
        let v = arg(argc, argv, i);
        // SAFETY: an inline tag check.
        if unsafe { qjs::JS_IsString(v) }
            && let Err(e) = set_prop(cx, root, name, v, UNDEFINED)
        {
            return e;
        }
    }
    // Checked by the bundler; a hand-made bundle's wrong value is ignored.
    let status_bar = string_arg(cx, arg(argc, argv, 3))
        .and_then(|json| serde_json::from_str(&json).ok())
        .and_then(|v| nsh_core::StatusBarSetting::from_json(&v).ok());
    if let Some(setting) = status_bar
        && let Err(e) = push_op(
            cx,
            Op::Command {
                id: nsh_core::ROOT_ID,
                command: nsh_core::Command::SetStatusBar(setting),
            },
        )
    {
        return e;
    }
    let appearance =
        crate::env::parse_appearance(&string_arg(cx, arg(argc, argv, 2)).unwrap_or_default());
    match appearance {
        Some(a) => crate::env::set_appearance(cx, a),
        None => UNDEFINED,
    }
}

// --- Events ---------------------------------------------------------------------

/// The handler node `id` has for `event` (owned), if any.
pub(crate) fn handler(cx: *mut JsContext, id: NodeId, event: EventKind) -> Option<JsValue> {
    let d = dom(cx);
    let p = d.by_id(id);
    if p.is_null() {
        // A removed modal's dismissal: its handler, given away (owned).
        if event != EventKind::Dismiss {
            return None;
        }
        let mut dismissed = d.dismissed.borrow_mut();
        let i = dismissed.iter().position(|&(n, _)| n == id)?;
        return Some(dismissed.remove(i).1);
    }
    // SAFETY: live node data; a dup of the handler.
    unsafe { &(*p).handlers }
        .iter()
        .find(|h| h.event == event)
        .map(|h| unsafe { qjs::JS_DupValue(cx, h.value) })
}

// --- The primitives as components -----------------------------------------------------

/// A component rendering host element `tag` with its props (children too
/// when `children`): what `nsh`'s `View`, `nsh/webview`'s `WebView`, ...
/// are as values. Their tags are made in place by the compiler; this is
/// the path of `<C />` where `C` holds one.
pub(crate) fn host_component(cx: *mut JsContext, tag: &str, children: bool) -> JsValue {
    let name = new_string(cx, tag);
    let mut data = [
        name,
        if children {
            qjs::JS_TRUE
        } else {
            qjs::JS_FALSE
        },
    ];
    // SAFETY: the function keeps dups of `data`; ours is freed.
    unsafe {
        let f = qjs::JS_NewCFunctionData(cx, Some(render_host), 1, 0, 2, data.as_mut_ptr());
        qjs::JS_FreeValue(cx, name);
        f
    }
}

fn new_string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

unsafe extern "C" fn render_host(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    // SAFETY: two data values (`host_component`).
    let (tag, children) = unsafe { (*data, qjs::JS_ToBool(cx, *data.add(1)) == 1) };
    let Some(tag) = string_arg(cx, tag).and_then(|t| Tag::from_name(&t)) else {
        return UNDEFINED;
    };
    let node = match create_element(cx, tag) {
        Ok(node) => node,
        Err(e) => return e,
    };
    let skip: &[&str] = if children { &[] } else { &["children"] };
    let r = spread_except(cx, node, props, skip).and_then(|()| {
        if !children {
            return Ok(());
        }
        let reader = prop_reader(cx, props, "children");
        let r = insert_value_at(cx, node, reader, None);
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, reader) };
        r
    });
    match r {
        Ok(()) => reactive::finish_value(cx, node),
        Err(e) => {
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, node) };
            e
        }
    }
}

/// A function returning `props[key]` when called (owned).
pub(crate) fn prop_reader(cx: *mut JsContext, props: JsValue, key: &str) -> JsValue {
    let k = new_string(cx, key);
    let mut data = [props, k];
    // SAFETY: the function keeps dups of `data`; ours is freed.
    unsafe {
        let f = qjs::JS_NewCFunctionData(cx, Some(read_prop), 0, 0, 2, data.as_mut_ptr());
        qjs::JS_FreeValue(cx, k);
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
    // SAFETY: two data values (props, key); the atom is freed.
    unsafe {
        if !qjs::JS_IsObject(*data) {
            return UNDEFINED;
        }
        let key = qjs::JS_ValueToAtom(cx, *data.add(1));
        let v = qjs::JS_GetProperty(cx, *data, key);
        qjs::JS_FreeAtom(cx, key);
        v
    }
}

/// The global `If` (`<If when else>` called as a component: the compiler
/// compiles the tag itself to `cond`).
unsafe extern "C" fn if_component(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    let mut args = [
        prop_reader(cx, props, "when"),
        prop_reader(cx, props, "children"),
        prop_reader(cx, props, "else"),
    ];
    // SAFETY: `cond` keeps dups of what it uses; ours are freed.
    unsafe {
        let r = cond(cx, UNDEFINED, 3, args.as_mut_ptr());
        for v in args {
            qjs::JS_FreeValue(cx, v);
        }
        r
    }
}

/// The global `Each` (`<Each of key>` called as a component: the compiler
/// compiles the tag itself to `each`).
unsafe extern "C" fn each_component(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    // SAFETY: values got are owned; `each` keeps dups of what it uses.
    unsafe {
        let mut args = [
            prop_reader(cx, props, "of"),
            qjs::JS_GetPropertyStr(cx, props, c"children".as_ptr()),
            qjs::JS_GetPropertyStr(cx, props, c"key".as_ptr()),
        ];
        let r = if args[1..].iter().any(|v| qjs::JS_IsException(*v)) {
            qjs::JS_EXCEPTION
        } else {
            each(cx, UNDEFINED, 3, args.as_mut_ptr())
        };
        for v in args {
            qjs::JS_FreeValue(cx, v);
        }
        r
    }
}

/// Hands the pending exception of a listener of node `id` to the error
/// boundary the node was made under: whether one caught it (else it stays
/// pending, as before).
pub(crate) fn catch_listener_failure(cx: *mut JsContext, id: NodeId) -> bool {
    let p = dom(cx).by_id(id);
    if p.is_null() {
        return false;
    }
    // SAFETY: live node data.
    let owner = unsafe { (*p).owner };
    reactive::catch_pending(cx, owner)
}

// --- Error boundaries -------------------------------------------------------------

/// `ErrorBoundary({ fallback, children })`: its children, or its fallback
/// once something under them failed (a component's body, a binding, an
/// effect, a listener). `fallback(error, reset)` gets the thrown value and
/// what renders the children again; a fallback that is not a function of
/// arguments is shown as is. What fails in the fallback goes to the
/// boundary above.
///
/// A memo shows one or the other, reading the boundary's signal (`[error]`
/// while failed): the children render in a memo of their own under it,
/// whose context names the signal (`reactive::boundary_key`), so failures
/// under it reach the boundary; the outer memo running again disposes it.
pub(crate) unsafe extern "C" fn error_boundary(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let failed = reactive::new_signal(cx, UNDEFINED);
    let mut data = [failed, arg(argc, argv, 0)];
    // SAFETY: the function keeps dups of `data`; ours is freed.
    let func =
        unsafe { qjs::JS_NewCFunctionData(cx, Some(boundary_run), 0, 0, 2, data.as_mut_ptr()) };
    unsafe { qjs::JS_FreeValue(cx, failed) };
    if unsafe { qjs::JS_IsException(func) } {
        return func;
    }
    let view = reactive::memo(cx, func, false);
    reactive::finish_value(cx, view)
}

/// A run of an `ErrorBoundary`'s memo: the fallback while its signal holds
/// an error, else a memo rendering the children.
unsafe extern "C" fn boundary_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`error_boundary`); values got are freed.
    let (failed, props) = unsafe { (*data, *data.add(1)) };
    let state = unsafe { qjs::JS_Call(cx, failed, UNDEFINED, 0, ptr::null_mut()) };
    if unsafe { qjs::JS_IsException(state) } {
        return state;
    }
    // SAFETY: inline checks; values got are owned.
    unsafe {
        if !qjs::JS_IsArray(state) {
            qjs::JS_FreeValue(cx, state);
            let mut fdata = [failed, props];
            let func =
                qjs::JS_NewCFunctionData(cx, Some(boundary_view), 0, 0, 2, fdata.as_mut_ptr());
            if qjs::JS_IsException(func) {
                return func;
            }
            return reactive::memo(cx, func, false);
        }
        let error = qjs::JS_GetPropertyUint32(cx, state, 0);
        qjs::JS_FreeValue(cx, state);
        reactive::untracked_with(cx, || {
            let fallback = qjs::JS_GetPropertyStr(cx, props, c"fallback".as_ptr());
            if !qjs::JS_IsFunction(cx, fallback) || !node_ptr(cx, fallback).is_null() {
                qjs::JS_FreeValue(cx, error);
                return fallback;
            }
            let mut length = 0i32;
            let l = qjs::JS_GetPropertyStr(cx, fallback, c"length".as_ptr());
            qjs::JS_ToInt32(cx, &mut length, l);
            qjs::JS_FreeValue(cx, l);
            if length == 0 {
                // An element to show, as children are.
                qjs::JS_FreeValue(cx, error);
                return fallback;
            }
            let mut rdata = [failed];
            let reset =
                qjs::JS_NewCFunctionData(cx, Some(boundary_reset), 0, 0, 1, rdata.as_mut_ptr());
            let mut args = [error, reset];
            let r = qjs::JS_Call(cx, fallback, UNDEFINED, 2, args.as_mut_ptr());
            for v in [fallback, error, reset] {
                qjs::JS_FreeValue(cx, v);
            }
            r
        })
    }
}

/// The memo of an `ErrorBoundary`'s children: names the boundary in its
/// context, then renders them (untracked). A function among them gets a
/// memo of its own here, so that it runs under the boundary too.
unsafe extern "C" fn boundary_view(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (`boundary_run`); values got are owned.
    let (failed, props) = unsafe { (*data, *data.add(1)) };
    reactive::provide(cx, reactive::boundary_key(cx), failed);
    reactive::untracked_with(cx, || unsafe {
        let children = qjs::JS_GetPropertyStr(cx, props, c"children".as_ptr());
        if qjs::JS_IsException(children) {
            // Caught here, not as the memo's failure: a failed memo runs
            // again when it is read, and the children would render twice.
            reactive::catch_pending_at(cx, failed);
            return UNDEFINED;
        }
        if qjs::JS_IsFunction(cx, children) && node_ptr(cx, children).is_null() {
            return item_memo(cx, children);
        }
        match memoize_run(cx, children) {
            Some(memos) => {
                qjs::JS_FreeValue(cx, children);
                memos
            }
            None => children,
        }
    })
}

/// An `ErrorBoundary`'s `reset`: renders its children again.
unsafe extern "C" fn boundary_reset(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`boundary_run`).
    reactive::set_signal(cx, unsafe { *data }, UNDEFINED);
    reactive::finish_value(cx, UNDEFINED)
}

/// The globals of the renderer: `If` and `Each`, the control flow tags no
/// app imports.
pub(crate) fn install_globals(cx: *mut JsContext) {
    // SAFETY: the global object is ours to free; it takes the functions.
    unsafe {
        let global = qjs::JS_GetGlobalObject(cx);
        let f = reactive::new_function(cx, c"If", if_component, 1);
        qjs::JS_SetPropertyStr(cx, global, c"If".as_ptr(), f);
        let f = reactive::new_function(cx, c"Each", each_component, 1);
        qjs::JS_SetPropertyStr(cx, global, c"Each".as_ptr(), f);
        qjs::JS_FreeValue(cx, global);
    }
}

/// Gives `node` (borrowed) to ref `target` (borrowed): a signal is set to
/// it, a function called with it (untracked). False for other values,
/// which the compiled code assigns the node to (`ref={el}` with `let el`,
/// `ref={refs.input}`).
pub(crate) fn apply_ref(
    cx: *mut JsContext,
    target: JsValue,
    node: JsValue,
) -> Result<bool, JsValue> {
    match reactive::signal_kind(cx, target) {
        (true, _) => {
            // SAFETY: a dup the signal takes.
            reactive::set_signal(cx, target, unsafe { qjs::JS_DupValue(cx, node) });
            return Ok(true);
        }
        (_, true) => {
            return Err(throw_type(
                cx,
                "a ref cannot be a memo, which is read-only: give a signal, a function or a variable",
            ));
        }
        _ => {}
    }
    // SAFETY: a borrowed function, called untracked with the node.
    if unsafe { !qjs::JS_IsFunction(cx, target) } {
        return Ok(false);
    }
    let mut args = [node];
    let r = reactive::untracked_with(cx, || unsafe {
        qjs::JS_Call(cx, target, UNDEFINED, 1, args.as_mut_ptr())
    });
    if unsafe { qjs::JS_IsException(r) } {
        return Err(r);
    }
    unsafe { qjs::JS_FreeValue(cx, r) };
    Ok(true)
}

/// `ref(target, node, name)`: what compiled `ref={…}` calls with the
/// element (or a component's ref): [`apply_ref`], whether it took the
/// node. With `name`, the binding the ref names cannot be assigned (a
/// `const`, an import), so a target that takes no node is an error.
unsafe extern "C" fn ref_(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (target, node, name) = (arg(argc, argv, 0), arg(argc, argv, 1), arg(argc, argv, 2));
    match apply_ref(cx, target, node) {
        Ok(true) => qjs::JS_TRUE,
        Ok(false) if unsafe { qjs::JS_IsString(name) } => {
            let name = to_string(cx, name).unwrap_or_default();
            throw_type(
                cx,
                &format!(
                    "ref={{{name}}}: `{name}` cannot be assigned (a const or an import) and is neither \
                     a signal nor a function: declare it with `let`, or give a signal or a function"
                ),
            )
        }
        Ok(false) => qjs::JS_FALSE,
        Err(e) => e,
    }
}

/// The exports of `nsh:rt`.
pub(crate) const RT_EXPORTS: &[crate::modules::Item] = &[
    ("element", Export::Function(element, 1), Ts::Internal),
    ("text", Export::Function(text, 1), Ts::Internal),
    ("append", Export::Function(append, 2), Ts::Internal),
    ("insert", Export::Function(insert, 3), Ts::Internal),
    ("prop", Export::Function(prop, 3), Ts::Internal),
    ("bindProp", Export::Function(bind_prop, 3), Ts::Internal),
    ("spread", Export::Function(spread, 2), Ts::Internal),
    ("component", Export::Function(component, 2), Ts::Internal),
    ("cond", Export::Function(cond, 3), Ts::Internal),
    ("each", Export::Function(each, 3), Ts::Internal),
    ("merge", Export::Function(merge, 2), Ts::Internal),
    ("list", Export::Function(crate::list::list, 1), Ts::Internal),
    ("setup", Export::Function(setup, 4), Ts::Internal),
    ("font", Export::Function(font, 2), Ts::Internal),
    ("metaUrl", Export::Function(meta_url, 1), Ts::Internal),
    ("ref", Export::Function(ref_, 3), Ts::Internal),
];

/// `metaUrl(path)`: what `import.meta.url` of the app's module `path`
/// (relative to the app's directory) compiles to. The app's directory
/// is a `file:` URL where the host has one (`${pluginDir}`: a local or
/// packaged desktop app), else the page's URL (the web), else `asset:/`,
/// whose relative URLs the app's assets resolve (packaged mobile apps,
/// devices on the dev server).
unsafe extern "C" fn meta_url(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(path) = string_arg(cx, arg(argc, argv, 0)) else {
        return qjs::JS_EXCEPTION;
    };
    #[cfg(not(target_arch = "wasm32"))]
    let located = dom(cx)
        .shared
        .system_paths
        .borrow()
        .plugin_dir
        .clone()
        .and_then(|dir| url::Url::from_directory_path(dir).ok());
    // A page has no directory of its own on disk.
    #[cfg(target_arch = "wasm32")]
    let located = None;
    let base = located
        .or_else(|| crate::web::web(cx).base_url.clone())
        .or_else(|| url::Url::parse("asset:/").ok());
    let url = base
        .and_then(|base| base.join(&path).ok())
        .map_or_else(|| format!("asset:/{path}"), String::from);
    match crate::web::js::string(cx, &url) {
        Ok(v) => v.take(),
        Err(_) => qjs::JS_EXCEPTION,
    }
}

/// `font(uri, family)`: what `import Inter from "./Inter.ttf"` evaluates
/// to (its family); the host registers the font before the first frame.
unsafe extern "C" fn font(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (uri, family) = (arg(argc, argv, 0), arg(argc, argv, 1));
    let Some(uri) = string_arg(cx, uri) else {
        return qjs::JS_EXCEPTION;
    };
    dom(cx).shared.fonts.borrow_mut().push(uri);
    // SAFETY: a new reference for the caller.
    unsafe { qjs::JS_DupValue(cx, family) }
}

#[cfg(test)]
mod tests {
    use nsh_core::{EventKind, EventPayload, Op};

    use crate::Host;

    /// The ops since the last call, one line each (`Release` and the root's
    /// layout direction left out unless `all`).
    fn ops(host: &Host, all: bool) -> Vec<String> {
        let mut out = Vec::new();
        host.take_ops(&mut out);
        out.into_iter()
            .filter(|op| {
                all || !matches!(
                    op,
                    Op::Release { .. }
                        | Op::SetProp {
                            prop: nsh_core::Prop::LayoutDirection(_),
                            ..
                        }
                )
            })
            .map(|op| match op {
                Op::Create { id, tag } => format!("create {id} {tag:?}"),
                Op::CreateText { id, text } => format!("text {id} {text:?}"),
                Op::SetText { id, text } => format!("set text {id} {text:?}"),
                Op::Insert {
                    parent,
                    child,
                    before,
                } => match before {
                    Some(b) => format!("insert {child} into {parent} before {b}"),
                    None => format!("insert {child} into {parent}"),
                },
                Op::Remove { parent, child } => format!("remove {child} from {parent}"),
                Op::Release { id } => format!("release {id}"),
                Op::Listen { id, event, enabled } => format!("listen {id} {event:?} {enabled}"),
                Op::SetStyle { id, .. } => format!("style {id}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    /// The text JS reported with `report(value)` (a text node).
    fn reported(host: &Host) -> Vec<String> {
        let mut out = Vec::new();
        host.take_ops(&mut out);
        out.into_iter()
            .filter_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    const REPORT: &str = r#"
        import { text } from "nsh:rt";
        const report = (v) => text(JSON.stringify(v));
    "#;

    #[test]
    fn the_reactive_api() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
            import {{ signal, computed, effect, batch, untracked, cleanup }} from "nsh";
            const log = [];
            const n = signal(1);
            const double = computed(() => n() * 2);
            effect(() => {{
                log.push(`effect ${{double()}} ${{untracked(() => n())}}`);
                cleanup(() => log.push("cleanup"));
            }});
            n.set(2);
            n.update((x) => x + 1);
            batch(() => {{ n.set(10); n.set(4); }});
            log.push(typeof n, typeof double, "set" in n, "set" in double);
            report(log);
            "#
        ))
        .unwrap();
        assert_eq!(
            reported(&host),
            [
                r#"["effect 2 1","cleanup","effect 4 2","cleanup","effect 6 3","cleanup","effect 8 4","function","function",true,false]"#
            ]
        );
    }

    #[test]
    fn mounting_props_events_and_text_updates() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal } from "nsh";
            import { element, insert, prop, bindProp, append } from "nsh:rt";
            const count = signal(0);
            mount(() => {
                const v = element("view");
                prop(v, "onPress", () => count.update((c) => c + 1));
                bindProp(v, "accessibilityLabel", () => (count() > 1 ? "many" : "few"));
                const t = element("text");
                insert(t, () => count());
                append(v, t);
                return v;
            });
            "#,
        )
        .unwrap();
        assert_eq!(
            ops(&host, false),
            [
                "create 2 View",
                "listen 2 Press true",
                "SetProp { id: 2, prop: Accessibility(Label(Some(\"few\"))) }",
                "create 4 Text",
                "text 6 \"0\"",
                "insert 6 into 4",
                "insert 4 into 2",
                "insert 2 into 1",
            ]
        );
        host.dispatch_event(2, EventKind::Press, &EventPayload::None);
        assert_eq!(ops(&host, false), ["set text 6 \"1\""]);
        host.dispatch_event(2, EventKind::Press, &EventPayload::None);
        assert_eq!(
            ops(&host, false),
            [
                "SetProp { id: 2, prop: Accessibility(Label(Some(\"many\"))) }",
                "set text 6 \"2\""
            ]
        );
    }

    /// The texts made since the last call.
    fn texts(host: &Host) -> Vec<String> {
        texts_and_element(host).0
    }

    /// The texts made since the last call, and the last text element made.
    fn texts_and_element(host: &Host) -> (Vec<String>, Option<nsh_core::NodeId>) {
        let mut out = Vec::new();
        host.take_ops(&mut out);
        let element = out.iter().rev().find_map(|op| match op {
            Op::Create {
                id,
                tag: nsh_core::Tag::Text,
            } => Some(*id),
            _ => None,
        });
        let texts = out
            .into_iter()
            .filter_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                Op::SetText { text, .. } => Some(format!("set {text}")),
                _ => None,
            })
            .collect();
        (texts, element)
    }

    const BOUNDARY: &str = r#"
        import { mount, signal, ErrorBoundary } from "nsh";
        import { element, insert, text, prop, component } from "nsh:rt";
        const n = signal(0);
        globalThis.n = n;
        globalThis.failBody = false;
        const Risky = () => {
            if (globalThis.failBody) throw new Error("body");
            const t = element("text");
            prop(t, "onPress", () => { throw new Error("press"); });
            insert(t, () => {
                if (n() == 1) throw new Error("binding");
                return `n${n()}`;
            });
            return t;
        };
        const boundary = (children, label) => component(ErrorBoundary, {
            fallback: (error, reset) => {
                globalThis.reset = () => { n.set(0); reset(); };
                if (label == "inner") throw new Error(`fallback of ${error.message}`);
                return text(`${label} caught ${error.message}`);
            },
            get children() { return children(); },
        });
    "#;

    /// A failure under an `ErrorBoundary` (a binding, a component's body,
    /// a listener) shows its fallback in place of what failed; `reset()`
    /// renders the children again.
    #[test]
    fn error_boundaries_catch_and_reset() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{BOUNDARY}
            mount(() => {{
                const v = element("view");
                insert(v, text("before"));
                insert(v, boundary(() => component(Risky, {{}}), "outer"));
                return v;
            }});
            "#
        ))
        .unwrap();
        assert_eq!(texts(&host), ["before", "n0"]);
        // A binding fails: the boundary shows its fallback, nothing throws.
        assert!(host.eval_script("fail.js", "n.set(1)").is_ok());
        assert_eq!(texts(&host), ["outer caught binding"]);
        host.eval_script("reset.js", "reset()").unwrap();
        let (shown, element) = texts_and_element(&host);
        assert_eq!(shown, ["n0"]);
        // A listener fails.
        host.dispatch_event(element.unwrap(), EventKind::Press, &EventPayload::None);
        assert_eq!(texts(&host), ["outer caught press"]);
        // The body fails when rendered again.
        host.eval_script("body.js", "failBody = true; reset()")
            .unwrap();
        assert_eq!(texts(&host), ["outer caught body"]);
    }

    /// A failure in a fallback goes to the boundary above; with no
    /// boundary, the failure throws as before.
    #[test]
    fn error_boundaries_nest() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{BOUNDARY}
            mount(() => {{
                const v = element("view");
                insert(v, boundary(() => boundary(() => component(Risky, {{}}), "inner"), "outer"));
                return v;
            }});
            "#
        ))
        .unwrap();
        assert_eq!(texts(&host), ["n0"]);
        // The inner boundary's fallback throws: the outer one shows that.
        host.eval_script("fail.js", "n.set(1)").unwrap();
        assert_eq!(texts(&host), ["outer caught fallback of binding"]);

        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{BOUNDARY}
            mount(() => component(Risky, {{}}));
            "#
        ))
        .unwrap();
        assert_eq!(texts(&host), ["n0"]);
        assert!(host.eval_script("fail.js", "n.set(1)").is_err());
    }

    #[test]
    fn control_flow_and_keyed_rows() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal } from "nsh";
            import { element, insert, text, cond, each } from "nsh:rt";
            const show = signal(true);
            const items = signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
            globalThis.toggle = () => show.update((s) => !s);
            globalThis.reorder = () => items.set([{ id: "c" }, { id: "a" }, { id: "d" }]);
            mount(() => {
                const v = element("view");
                insert(v, cond(() => show(), () => text("on"), () => text("off")));
                insert(v, each(() => items(), (item, index) => {
                    const t = element("text");
                    insert(t, () => `${item().id}${index()}`);
                    return t;
                }, (item) => item.id));
                return v;
            });
            "#,
        )
        .unwrap();
        let first = ops(&host, false);
        assert!(first.contains(&"text 4 \"on\"".to_owned()), "{first:?}");
        host.eval_script("toggle.js", "toggle()").unwrap();
        assert_eq!(
            ops(&host, false),
            [
                "text 18 \"off\"",
                "remove 4 from 2",
                "insert 18 into 2 before 6"
            ]
        );
        // `b` goes, `c` moves first, `d` is new; `a` and `c` show their new
        // indexes in place.
        host.eval_script("reorder.js", "reorder()").unwrap();
        assert_eq!(
            ops(&host, false),
            [
                "create 20 Text",
                "text 22 \"d2\"",
                "insert 22 into 20",
                "insert 14 into 2 before 6",
                "remove 10 from 2",
                "insert 20 into 2",
                "set text 16 \"c0\"",
                "set text 8 \"a1\"",
            ]
        );
    }

    /// `key="index"` keeps rows by position: changed strings update their
    /// rows in place; a key function gets the index too.
    #[test]
    fn rows_keyed_by_index() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal } from "nsh";
            import { element, insert, each } from "nsh:rt";
            const lines = signal(["a"]);
            globalThis.stream = (v) => lines.set(v);
            const render = (item) => {
                const t = element("text");
                insert(t, () => item());
                return t;
            };
            mount(() => {
                const v = element("view");
                insert(v, each(() => lines(), render, "index"));
                const w = element("view");
                insert(w, each(() => lines(), render, (item, i) => i));
                insert(v, w);
                return v;
            });
            "#,
        )
        .unwrap();
        ops(&host, false);
        host.eval_script("stream.js", "stream(['ab'])").unwrap();
        assert_eq!(
            ops(&host, false),
            ["set text 6 \"ab\"", "set text 12 \"ab\""]
        );
        host.eval_script("stream.js", "stream(['ab', 'c'])")
            .unwrap();
        let grown = ops(&host, false);
        assert_eq!(
            grown.iter().filter(|l| l.starts_with("create")).count(),
            2,
            "{grown:?}"
        );
        assert!(!grown.iter().any(|l| l.starts_with("remove")), "{grown:?}");
    }

    /// Rows of repeated values (keyed by value, by index and by a key
    /// function) end up in the array's order: equal keys match in order,
    /// and the reconcile anchors appends on nodes in place.
    #[test]
    fn rows_with_duplicate_keys_follow_the_array() {
        use std::collections::HashMap;

        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal } from "nsh";
            import { element, insert, each } from "nsh:rt";
            const values = signal([]);
            globalThis.show = (v) => values.set(v);
            const render = (item) => {
                const t = element("text");
                insert(t, () => String(item()));
                return t;
            };
            mount(() => {
                const v = element("view");
                for (const key of [undefined, "index", (item) => item]) {
                    const w = element("view");
                    insert(w, each(() => values(), render, key));
                    insert(v, w);
                }
                return v;
            });
            "#,
        )
        .unwrap();
        // The tree the ops build: children per parent, the text of text
        // nodes.
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut texts: HashMap<u32, String> = HashMap::new();
        let apply = |children: &mut HashMap<u32, Vec<u32>>, texts: &mut HashMap<u32, String>| {
            let mut out = Vec::new();
            host.take_ops(&mut out);
            for op in out {
                match op {
                    Op::CreateText { id, text } | Op::SetText { id, text } => {
                        texts.insert(id, text);
                    }
                    Op::Insert {
                        parent,
                        child,
                        before,
                    } => {
                        let list = children.entry(parent).or_default();
                        list.retain(|&c| c != child);
                        let at = before
                            .and_then(|b| list.iter().position(|&c| c == b))
                            .unwrap_or(list.len());
                        list.insert(at, child);
                    }
                    Op::Remove { parent, child } => {
                        children.entry(parent).or_default().retain(|&c| c != child);
                    }
                    _ => {}
                }
            }
        };
        apply(&mut children, &mut texts);
        let root = children[&1][0];
        let lists = children[&root].clone();
        assert_eq!(lists.len(), 3);
        let history: &[&[u32]] = &[
            &[1],
            &[2, 1],
            &[3, 2, 1],
            &[2, 3, 2, 1],
            &[1, 2, 3, 2, 1],
            &[2, 1, 2, 3, 2],
            &[2, 2, 1, 2, 3],
            &[3, 2, 2, 2, 1],
            &[1, 3, 1, 3, 2],
            &[],
            &[4, 4, 4],
            &[5, 4, 5, 4],
        ];
        // Then arrays of up to 8 values out of 4, pseudo-random.
        let mut seed = 7u32;
        let mut next = move |n: u32| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (seed >> 16) % n
        };
        let random: Vec<Vec<u32>> = (0..300)
            .map(|_| (0..next(9)).map(|_| next(4)).collect())
            .collect();
        for values in history
            .iter()
            .copied()
            .chain(random.iter().map(Vec::as_slice))
        {
            let list = values.iter().map(u32::to_string).collect::<Vec<_>>();
            host.eval_script("show.js", &format!("show([{}])", list.join(",")))
                .unwrap();
            apply(&mut children, &mut texts);
            for &w in &lists {
                let shown: Vec<_> = children
                    .get(&w)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .map(|row| texts[&children[row][0]].clone())
                    .collect();
                assert_eq!(shown, list, "rows of {w}");
            }
        }
    }

    /// A run of dynamic children (one insert): a change in one leaves the
    /// others' nodes alone (`<Text>{spans()}{tail()}</Text>`).
    #[test]
    fn dynamic_siblings_run_alone() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
            import {{ mount, signal }} from "nsh";
            import {{ element, insert }} from "nsh:rt";
            const words = signal(["a"]);
            let tails = 0;
            globalThis.grow = () => words.update((w) => [...w, "b"]);
            globalThis.check = () => report(tails);
            const tail = () => {{ tails++; return element("view"); }};
            mount(() => {{
                const t = element("text");
                insert(t, [() => words().map((w) => text(w)), () => tail()]);
                return t;
            }});
            "#
        ))
        .unwrap();
        ops(&host, false);
        host.eval_script("grow.js", "grow()").unwrap();
        assert_eq!(
            ops(&host, false),
            [
                "text 8 \"a\"",
                "text 10 \"b\"",
                "remove 4 from 2",
                "insert 8 into 2 before 6",
                "insert 10 into 2 before 6"
            ]
        );
        host.eval_script("check.js", "check()").unwrap();
        assert_eq!(reported(&host), ["1"]);
    }

    /// `contentStyle` moves a scroll view's children into a view
    /// it styles, whatever order props and children come in.
    #[test]
    fn scroll_content_container() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal } from "nsh";
            import { element, insert, prop, append, text } from "nsh:rt";
            const show = signal(false);
            globalThis.toggle = () => show.update((s) => !s);
            mount(() => {
                const v = element("view");
                const s = element("scroll");
                prop(s, "contentStyle", { flexGrow: 1 });
                append(s, text("a"));
                insert(s, () => (show() ? text("b") : null));
                append(v, s);
                const t = element("scroll");
                append(t, text("c"));
                prop(t, "contentClass", "grow");
                append(v, t);
                return v;
            });
            "#,
        )
        .unwrap();
        let first = ops(&host, false);
        for line in [
            "create 4 Scroll",
            "create 6 View",
            "insert 6 into 4",
            "style 6",
            "insert 8 into 6",
            "insert 12 into 10",
            "create 14 View",
            "insert 14 into 10 before 12",
            "insert 12 into 14",
        ] {
            assert!(first.contains(&line.to_owned()), "{line}: {first:?}");
        }
        host.eval_script("toggle.js", "toggle()").unwrap();
        assert_eq!(ops(&host, false), ["text 16 \"b\"", "insert 16 into 6"]);
    }

    /// The primitives and the globals `If` / `Each` as values: what
    /// `<C />` calls when `C` holds one.
    #[test]
    fn primitives_and_control_flow_are_components() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal, View, Text, Image } from "nsh";
            import { component } from "nsh:rt";
            const show = signal(true);
            globalThis.toggle = () => show.update((s) => !s);
            if (typeof Image.getSize !== "function" || typeof Image.prefetch !== "function") {
                throw new Error("Image carries its functions");
            }
            mount(() => component(View, {
                testID: "box",
                get children() {
                    return [
                        component(If, {
                            get when() { return show(); },
                            get children() { return component(Text, { children: "on" }); },
                            get else() { return component(Image, { src: "x" }); },
                        }),
                        component(Each, { of: ["a", "b"], children: (item) => component(Text, { get children() { return item(); } }) }),
                    ];
                },
            }));
            "#,
        )
        .unwrap();
        let first = ops(&host, false);
        for line in ["create 2 View", "create 4 Text", "text 6 \"on\""] {
            assert!(first.contains(&line.to_owned()), "{line}: {first:?}");
        }
        assert!(first.iter().any(|l| l.contains("TestId")), "{first:?}");
        assert!(first.iter().any(|l| l.contains("\"b\"")), "{first:?}");
        host.eval_script("toggle.js", "toggle()").unwrap();
        let toggled = ops(&host, false);
        assert!(toggled.iter().any(|l| l.ends_with("Image")), "{toggled:?}");
    }

    #[test]
    fn contexts_reach_what_providers_render() {
        let host = Host::new().unwrap();
        host.eval_source(&format!(
            r#"{REPORT}
            import {{ context, mount }} from "nsh";
            import {{ component }} from "nsh:rt";
            const Theme = context("light");
            const seen = [Theme()];
            const Child = () => {{ seen.push(Theme()); return null; }};
            mount(() => component(Theme.Provider, {{
                value: "dark",
                get children() {{ return [component(Child, {{}}), () => component(Child, {{}})]; }},
            }}));
            report(seen);
            "#
        ))
        .unwrap();
        assert_eq!(reported(&host), [r#"["light","dark","dark"]"#]);
    }

    #[test]
    fn node_methods_send_commands() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { element } from "nsh:rt";
            const s = element("scroll");
            s.scrollTo({ y: 10, animated: false });
            s.scrollToIndex({ index: 3 });
            s.scrollToIndex({ index: 7, viewPosition: 0.5, animated: false, automatic: true });
            const i = element("input");
            i.focus();
            i.setSelection(2);
            i.replaceRange({ start: 0, end: 2, text: "😀\nskill", expectedText: "ab", expectedSelection: { start: 2, end: 2 } });
            globalThis.keep = [s, i];
            "#,
        )
        .unwrap();
        let commands: Vec<String> = ops(&host, false)
            .into_iter()
            .filter(|o| o.starts_with("Command"))
            .collect();
        assert_eq!(
            commands,
            [
                "Command { id: 2, command: ScrollTo { x: 0pt, y: 10pt, animated: false } }",
                "Command { id: 2, command: ScrollToIndex { index: 3, animated: true, automatic: false, view_position: 0%, view_offset: 0pt } }",
                "Command { id: 2, command: ScrollToIndex { index: 7, animated: false, automatic: true, view_position: 50%, view_offset: 0pt } }",
                "Command { id: 4, command: Focus }",
                "Command { id: 4, command: SetSelection { start: 2, end: 2 } }",
                r#"Command { id: 4, command: ReplaceRange { range: 0..2, text: "😀\nskill", expected_text: "ab", expected_selection: 2..2, count: 0 } }"#,
            ]
        );
    }

    #[test]
    fn collected_nodes_are_released() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { element, append } from "nsh:rt";
            (() => {
                const v = element("view");
                append(v, element("text"));
            })();
            globalThis.keep = element("view");
            "#,
        )
        .unwrap();
        // Unreferenced at once: released with the first batch.
        let first = ops(&host, true);
        assert_eq!(&first[first.len() - 2..], ["release 2", "release 4"]);
        host.collect_garbage();
        assert!(ops(&host, true).is_empty(), "the kept view stays");
    }

    #[test]
    fn bytecode_imports_native_modules() {
        let bytecode = crate::compile_bytecode(
            r#"import { signal } from "nsh"; import { text } from "nsh:rt"; const s = signal(7); text(String(s()));"#,
            false,
        )
        .unwrap();
        let host = Host::new().unwrap();
        host.eval_bytecode(&bytecode).unwrap();
        assert_eq!(reported(&host), ["7"]);
        // Names are checked when the module links.
        let bytecode = crate::compile_bytecode(r#"import { nope } from "nsh";"#, false).unwrap();
        let err = Host::new().unwrap().eval_bytecode(&bytecode).unwrap_err();
        assert!(err.message.contains("nope"), "{err}");
    }
}
