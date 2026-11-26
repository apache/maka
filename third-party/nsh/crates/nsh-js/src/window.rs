//! `nsh/desktop`'s windows: `<Window>` and `Window.open` (a dialog root the
//! platform shows in a window of its own, rendered from the app's one
//! engine), the `WindowRef` handles of the app's windows,
//! `currentWindow()` (the window a component renders in, through context),
//! `windows()`, `focusedWindow()`, `windowState()` and `titleBar()`. Off
//! the desktops there are no windows: `<Window>` renders its content in the
//! app's one surface, `currentWindow()` is that surface and `windows()` lists
//! it.
//!
//! The attributes, the options and the requests are the core's types
//! (`nsh_core::desktop`): a handle only decodes its arguments and queues
//! the command; the core keeps one attribute record per window and sends
//! the platform what changed. What the platform reports of a window comes
//! natively ([`platform_event`]) and runs the listeners registered with
//! `on`.

use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_int},
    ptr,
};

use nsh_core::{
    Command, EventKind, NodeId, Op, ROOT_ID, Tag,
    desktop::{
        DesktopCommand, OpenWindow, WindowAttributes, WindowCloseCause, WindowEvent, WindowFrame,
        WindowMode, WindowOptions, WindowPlacement, WindowRequest, WindowState,
    },
    element::{JsError, JsOwned, codes},
    geometry::{Edges, Points},
};
use rquickjs::qjs;

use crate::{
    dom,
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;
type DataFn = unsafe extern "C" fn(
    *mut JsContext,
    JsValue,
    c_int,
    *mut JsValue,
    c_int,
    *mut JsValue,
) -> JsValue;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// What a listener of a window hears (`WindowRef.on`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Event {
    ClosePress,
    Close,
    FocusChange,
    ModeChange,
    BoundsChange,
    DisplayChange,
}

impl Event {
    fn parse(name: &str) -> Option<Event> {
        Some(match name {
            "closePress" => Event::ClosePress,
            "close" => Event::Close,
            "focusChange" => Event::FocusChange,
            "modeChange" => Event::ModeChange,
            "boundsChange" => Event::BoundsChange,
            "displayChange" => Event::DisplayChange,
            _ => return None,
        })
    }
}

/// A listener of a window (`WindowRef.on`, `<Window>`'s event props).
struct Listener {
    id: u32,
    /// The window's root node.
    window: NodeId,
    event: Event,
    /// Called with the event's object (owned).
    f: JsValue,
}

/// How a window of the app's own came to be.
enum How {
    /// `Window.open`: the dialog root it inserted into the root (owned) and
    /// the reactive root its content renders in.
    Opened { node: JsValue, owner: u32 },
    /// `<Window>`: the function that closes it as the user did (owned;
    /// called with the reason's name): the element hides its content and
    /// tells the app (`onOpenChange`), and the reactive root its content
    /// rendered in (disposed when the window goes).
    Element { close: JsValue, owner: u32 },
}

/// A window of the app's own while it is open.
struct Own {
    /// The app's id for it.
    key: String,
    /// Its root node.
    id: NodeId,
    /// Its `WindowRef` (owned).
    handle: JsValue,
    /// Its state's signal (owned): `null` until the platform reports.
    state: JsValue,
    /// What the platform reported last.
    last: Option<WindowState>,
    /// Its hidden title bar's area's signal (owned): zeros until the
    /// platform reports.
    title_bar: JsValue,
    how: How,
}

/// The windows' part of a context's state.
pub(crate) struct Windows {
    /// The context key of the current window (owned; made on first use).
    key: Cell<JsValue>,
    /// A signal of a number counting changes to the list (owned; made on
    /// first use): `windows()` reads it.
    version: Cell<JsValue>,
    /// The host surface's `WindowRef` (owned; made on first use).
    surface: Cell<JsValue>,
    /// The implicit first window `mount` declared but has not opened yet
    /// (its node, the attributes the app set while the root rendered, and
    /// the requests it made): opened when the root turns out to return
    /// plain content, dropped when it declares windows of its own.
    pending: RefCell<Option<(NodeId, WindowAttributes, Vec<WindowRequest>)>>,
    /// The `WindowRef`s of implicit first windows that were dropped
    /// unopened (owned). The app root's context may still hold one: a
    /// callback of the root that calls `currentWindow()` finds it rather
    /// than a freed object. A window ref is not a window: it is never open.
    unopened: RefCell<Vec<JsValue>>,
    /// The windows of the app's own, oldest first.
    list: RefCell<Vec<Own>>,
    listeners: RefCell<Vec<Listener>>,
    next: Cell<u32>,
    /// True when hosted inside an embedder's visible `AppView` rather than a
    /// standalone hidden-host desktop runner: `mount` renders directly into
    /// `ROOT_ID` instead of opening an implicit OS window.
    pub(crate) embedded: Cell<bool>,
}

impl Default for Windows {
    fn default() -> Self {
        Windows {
            key: Cell::new(UNDEFINED),
            version: Cell::new(UNDEFINED),
            surface: Cell::new(UNDEFINED),
            pending: RefCell::default(),
            unopened: RefCell::default(),
            list: RefCell::default(),
            listeners: RefCell::default(),
            next: Cell::new(0),
            embedded: Cell::new(false),
        }
    }
}

pub(crate) fn is_embedded(cx: *mut JsContext) -> bool {
    windows(cx).embedded.get()
}

pub(crate) fn embedded_main_state_changed(
    cx: *mut JsContext,
    old: Option<&WindowState>,
    new: Option<&WindowState>,
) {
    state_changed(cx, ROOT_ID, old, new);
}

impl Windows {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        // SAFETY: owned values; no JS runs from here on.
        unsafe {
            for c in [&self.key, &self.version, &self.surface] {
                qjs::JS_FreeValue(raw, c.replace(UNDEFINED));
            }
            for v in self.unopened.get_mut().drain(..) {
                qjs::JS_FreeValue(raw, v);
            }
            for w in self.list.get_mut().drain(..) {
                qjs::JS_FreeValue(raw, w.handle);
                qjs::JS_FreeValue(raw, w.state);
                qjs::JS_FreeValue(raw, w.title_bar);
                match w.how {
                    How::Opened { node, .. } => qjs::JS_FreeValue(raw, node),
                    How::Element { close, .. } => qjs::JS_FreeValue(raw, close),
                }
            }
            for l in self.listeners.get_mut().drain(..) {
                qjs::JS_FreeValue(raw, l.f);
            }
        }
    }
}

fn windows<'a>(cx: *mut JsContext) -> &'a Windows {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).windows }
}

// --- Helpers ---------------------------------------------------------------------------

fn free(cx: *mut JsContext, v: JsValue) {
    // SAFETY: an owned value.
    unsafe { qjs::JS_FreeValue(cx, v) };
}

fn dup(cx: *mut JsContext, v: JsValue) -> JsValue {
    // SAFETY: a dup of a live value.
    unsafe { qjs::JS_DupValue(cx, v) }
}

fn nullish(v: JsValue) -> bool {
    // SAFETY: inline tag checks.
    unsafe { qjs::JS_IsUndefined(v) || qjs::JS_IsNull(v) }
}

fn is_exception(v: JsValue) -> bool {
    // SAFETY: an inline tag check.
    unsafe { qjs::JS_IsException(v) }
}

fn get(cx: *mut JsContext, object: JsValue, key: &CStr) -> JsValue {
    // SAFETY: a property read of a live value.
    unsafe {
        if !qjs::JS_IsObject(object) {
            return UNDEFINED;
        }
        qjs::JS_GetPropertyStr(cx, object, key.as_ptr())
    }
}

fn set(cx: *mut JsContext, object: JsValue, key: &CStr, value: JsValue) {
    // SAFETY: the object takes the value.
    unsafe { qjs::JS_SetPropertyStr(cx, object, key.as_ptr(), value) };
}

fn string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

fn boolean(b: bool) -> JsValue {
    if b { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

fn number(n: f64) -> JsValue {
    qjs::JS_NewFloat64(n)
}

fn new_object(cx: *mut JsContext) -> JsValue {
    // SAFETY: a new object.
    unsafe { qjs::JS_NewObject(cx) }
}

/// `v` as a number, if it is one.
fn as_number(cx: *mut JsContext, v: JsValue) -> Option<f64> {
    // SAFETY: an inline tag check, then a conversion of a number.
    unsafe {
        if !qjs::JS_IsNumber(v) {
            return None;
        }
        let mut n = 0f64;
        qjs::JS_ToFloat64(cx, &mut n, v);
        Some(n)
    }
}

fn truthy(cx: *mut JsContext, v: JsValue) -> bool {
    // SAFETY: a conversion of a live value.
    unsafe { qjs::JS_ToBool(cx, v) > 0 }
}

/// Calls `f` with `args` (borrowed) and frees what it returns; `false`
/// when it threw (left pending).
fn call(cx: *mut JsContext, f: JsValue, args: &mut [JsValue]) -> bool {
    // SAFETY: a call of a live function with borrowed arguments.
    let r = unsafe { qjs::JS_Call(cx, f, UNDEFINED, args.len() as c_int, args.as_mut_ptr()) };
    let ok = !is_exception(r);
    free(cx, r);
    ok
}

/// Calls `f` with no arguments (tracked: a signal or an accessor) and
/// returns what it returns (owned).
fn read(cx: *mut JsContext, f: JsValue) -> JsValue {
    // SAFETY: a call of a live function.
    unsafe { qjs::JS_Call(cx, f, UNDEFINED, 0, ptr::null_mut()) }
}

/// A function with `data` (dups kept) and `magic`.
fn native(
    cx: *mut JsContext,
    f: DataFn,
    length: c_int,
    magic: c_int,
    data: &mut [JsValue],
) -> JsValue {
    // SAFETY: the function keeps dups of `data`.
    unsafe {
        qjs::JS_NewCFunctionData(
            cx,
            Some(f),
            length,
            magic,
            data.len() as c_int,
            data.as_mut_ptr(),
        )
    }
}

/// Throws a `TypeError` with `message`.
fn type_error(cx: *mut JsContext, message: &str) -> JsValue {
    let _ = crate::web::js::type_error(cx, message);
    qjs::JS_EXCEPTION
}

/// Throws `error`.
fn throw(cx: *mut JsContext, error: JsError) -> JsValue {
    use nsh_core::element::IntoThrown as _;
    let value = crate::classes::error_value(cx, &error.into_thrown());
    let _ = crate::web::js::throw(cx, value);
    qjs::JS_EXCEPTION
}

/// `v` decoded by `T`'s conversion (the core's types).
fn decode<T: nsh_core::element::JsValue>(cx: *mut JsContext, v: JsValue) -> Result<T, String> {
    let host = crate::classes::host_outside_calls(cx);
    let owned = JsOwned::new(&host, crate::classes::to_raw(dup(cx, v)));
    let decoded = T::from_js(owned.get()).map_err(|e| e.0);
    drop(owned);
    host.clear_pending();
    decoded
}

/// `value` as JS (owned), `undefined` when its conversion fails.
fn encode<T: nsh_core::element::JsValue>(cx: *mut JsContext, value: &T) -> JsValue {
    crate::env::to_js(cx, value)
}

/// Queues `command` for node `id`.
fn send(cx: *mut JsContext, id: NodeId, command: DesktopCommand) -> Result<(), JsValue> {
    dom::push_op(
        cx,
        Op::Command {
            id,
            command: Command::Desktop(Box::new(command)),
        },
    )
}

fn context_key(cx: *mut JsContext) -> JsValue {
    let w = windows(cx);
    if nullish(w.key.get()) {
        w.key.set(new_object(cx));
    }
    w.key.get()
}

fn version(cx: *mut JsContext) -> JsValue {
    let w = windows(cx);
    if nullish(w.version.get()) {
        w.version.set(reactive::new_signal(cx, number(0.0)));
    }
    w.version.get()
}

/// Tells `windows()` the list changed.
fn bump(cx: *mut JsContext) {
    let v = version(cx);
    let n = reactive::peek_number(cx, v).unwrap_or(0.0);
    reactive::set_signal(cx, v, number(n + 1.0));
}

/// The app root's `WindowRef` (owned): the main window a released app
/// renders in when it declares no window of its own. On the desktops it is
/// the runtime's implicit first window when one is open (`mount` opens it
/// for a plain root), else the hidden host's ref; off them it is the app's
/// one surface, as the old model's main window was.
fn main_ref(cx: *mut JsContext) -> JsValue {
    let open = windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.key == "main")
        .map(|w| dup(cx, w.handle));
    open.unwrap_or_else(|| surface_ref(cx))
}

/// The host surface's `WindowRef` (owned), even when a separate window
/// has the name `"main"`.
fn surface_ref(cx: *mut JsContext) -> JsValue {
    let w = windows(cx);
    if nullish(w.surface.get()) {
        w.surface
            .set(make_handle(cx, "main", ROOT_ID, qjs::JS_NULL));
    }
    dup(cx, w.surface.get())
}

/// The node of the window with `key`, if it is open.
fn node_of_key(cx: *mut JsContext, key: &str) -> Option<NodeId> {
    windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.key == key)
        .map(|w| w.id)
        .or_else(|| (is_embedded(cx) && key == "main").then_some(ROOT_ID))
}

/// The handle of the window at node `id` (owned), if it is open.
fn handle_of(cx: *mut JsContext, id: NodeId) -> Option<JsValue> {
    windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.id == id)
        .map(|w| dup(cx, w.handle))
        .or_else(|| (is_embedded(cx) && id == ROOT_ID).then(|| main_ref(cx)))
}

/// A window's state as JS (owned; `null` without one), its `display` the
/// display object of `displays()`.
pub(crate) fn state_value(cx: *mut JsContext, state: Option<&WindowState>) -> JsValue {
    let Some(state) = state else {
        return qjs::JS_NULL;
    };
    let value = encode(cx, state);
    if nullish(value) {
        return value;
    }
    let display = state.display.and_then(|id| {
        crate::env::display_list(cx)
            .into_iter()
            .find(|d| d.id == id)
    });
    let display = match display {
        Some(d) => encode(cx, &d),
        None => qjs::JS_NULL,
    };
    set(cx, value, c"display", display);
    value
}

// --- Handles ---------------------------------------------------------------------------

/// The methods of a `WindowRef`, by magic.
const METHODS: &[(&CStr, c_int)] = &[
    (c"state", 0),
    (c"titleBar", 0),
    (c"set", 1),
    (c"show", 0),
    (c"hide", 0),
    (c"focus", 0),
    (c"close", 0),
    (c"minimize", 0),
    (c"restore", 0),
    (c"setMode", 1),
    (c"setBounds", 1),
    (c"setPlacement", 1),
    (c"center", 1),
    (c"requestAttention", 1),
    (c"on", 2),
];

/// A new `WindowRef` for the window `key` at node `id` (owned).
fn make_handle(cx: *mut JsContext, key: &str, id: NodeId, parent: JsValue) -> JsValue {
    let handle = new_object(cx);
    set(cx, handle, c"id", string(cx, key));
    // `"main"` is the first window's conventional id, with no privilege.
    set(cx, handle, c"main", boolean(key == "main"));
    set(cx, handle, c"parent", dup(cx, parent));
    let mut data = [number(id as f64)];
    for (magic, (name, length)) in METHODS.iter().enumerate() {
        let f = native(cx, ref_call, *length, magic as c_int, &mut data);
        set(cx, handle, name, f);
    }
    handle
}

/// Whether node `id` is a window that is open (off the desktops the app
/// root's ref is the app's one surface, which is always open).
fn is_open(cx: *mut JsContext, id: NodeId) -> bool {
    (id == ROOT_ID && (!windows_supported(cx) || is_embedded(cx)))
        || windows(cx).list.borrow().iter().any(|w| w.id == id)
        || windows(cx)
            .pending
            .borrow()
            .as_ref()
            .is_some_and(|(pending, _, _)| *pending == id)
}

/// A `WindowRef`'s methods: `METHODS[magic]` of the window at the node
/// `data` holds.
unsafe extern "C" fn ref_call(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`make_handle`).
    let id = as_number(cx, unsafe { *data }).unwrap_or(0.0) as NodeId;
    let a0 = arg(argc, argv, 0);
    let request = |r: WindowRequest| -> JsValue {
        if !is_open(cx, id) {
            return UNDEFINED;
        }
        // The implicit first window has not opened yet: what the app asks
        // of it goes to it once it opens.
        if let Some((pending, _, requests)) = windows(cx).pending.borrow_mut().as_mut()
            && *pending == id
        {
            requests.push(r);
            return UNDEFINED;
        }
        match send(cx, id, DesktopCommand::Request(r)) {
            Ok(()) => UNDEFINED,
            Err(e) => e,
        }
    };
    let name = METHODS[magic as usize].0.to_str().unwrap_or("");
    match name {
        "state" => state_of(cx, id),
        "titleBar" => title_bar_of(cx, id),
        "set" => {
            let attributes = match decode::<WindowAttributes>(cx, a0) {
                Ok(a) => a,
                Err(e) => return type_error(cx, &format!("WindowRef.set: {e}")),
            };
            if attributes.is_empty() || !is_open(cx, id) {
                return UNDEFINED;
            }
            // The implicit first window has not opened yet: what the app
            // sets joins the options it opens with.
            if let Some((pending, pending_attributes, _)) =
                windows(cx).pending.borrow_mut().as_mut()
                && *pending == id
            {
                pending_attributes.merge(&attributes);
                return UNDEFINED;
            }
            match send(cx, id, DesktopCommand::SetAttributes(Box::new(attributes))) {
                Ok(()) => UNDEFINED,
                Err(e) => e,
            }
        }
        "show" => request(WindowRequest::Show),
        "hide" => request(WindowRequest::Hide),
        "focus" => request(WindowRequest::Focus),
        "close" => close_own(cx, id, None),
        "minimize" => request(WindowRequest::Minimize),
        "restore" => request(WindowRequest::Restore),
        "setMode" => match decode::<WindowMode>(cx, a0) {
            Ok(mode) => request(WindowRequest::SetMode(mode)),
            Err(e) => type_error(cx, &format!("WindowRef.setMode: {e}")),
        },
        "setBounds" => match bounds_arg(cx, a0) {
            Ok(frame) => request(WindowRequest::SetBounds(frame)),
            Err(e) => type_error(cx, &format!("WindowRef.setBounds: {e}")),
        },
        "setPlacement" => match decode::<WindowPlacement>(cx, a0) {
            Ok(p) => request(WindowRequest::SetPlacement(p)),
            Err(e) => type_error(cx, &format!("WindowRef.setPlacement: {e}")),
        },
        "center" => {
            let display = get(cx, a0, c"display");
            let display = if nullish(display) {
                Ok(None)
            } else {
                decode(cx, display).map(Some)
            };
            match display {
                Ok(display) => request(WindowRequest::Center { display }),
                Err(e) => type_error(cx, &format!("WindowRef.center: {e}")),
            }
        }
        "requestAttention" => {
            let critical = get(cx, a0, c"critical");
            let critical = truthy(cx, critical);
            request(WindowRequest::RequestAttention { critical })
        }
        "on" => on(cx, id, a0, arg(argc, argv, 1)),
        _ => UNDEFINED,
    }
}

/// `setBounds`' `{ origin?, size?, animated? }`.
fn bounds_arg(cx: *mut JsContext, v: JsValue) -> Result<WindowFrame, String> {
    // SAFETY: an inline tag check.
    if !unsafe { qjs::JS_IsObject(v) } {
        return Err("takes { origin?, size?, animated? }".into());
    }
    let field = |object: JsValue, key: &CStr| -> Option<f64> {
        let x = get(cx, object, key);
        let n = as_number(cx, x);
        free(cx, x);
        n.filter(|n| n.is_finite())
    };
    let origin = get(cx, v, c"origin");
    let size = get(cx, v, c"size");
    let animated = get(cx, v, c"animated");
    let frame = WindowFrame {
        x: field(origin, c"x").map(|x| Points(x as f32)),
        y: field(origin, c"y").map(|y| Points(y as f32)),
        width: field(size, c"width")
            .filter(|w| *w > 0.0)
            .map(|w| Points(w as f32)),
        height: field(size, c"height")
            .filter(|h| *h > 0.0)
            .map(|h| Points(h as f32)),
        animated: (!nullish(animated)).then(|| truthy(cx, animated)),
    };
    free(cx, origin);
    free(cx, size);
    free(cx, animated);
    Ok(frame)
}

/// `WindowRef.state()` (owned; tracked).
fn state_of(cx: *mut JsContext, id: NodeId) -> JsValue {
    if id == ROOT_ID && is_embedded(cx) {
        return crate::env::read_window_state(cx);
    }
    let signal = windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.id == id)
        .map(|w| dup(cx, w.state));
    match signal {
        Some(signal) => {
            let v = read(cx, signal);
            free(cx, signal);
            v
        }
        // Closed: `windows()` changed when it did.
        None => {
            free(cx, read(cx, version(cx)));
            qjs::JS_NULL
        }
    }
}

/// `WindowRef.titleBar()` (owned; tracked).
fn title_bar_of(cx: *mut JsContext, id: NodeId) -> JsValue {
    if id == ROOT_ID && is_embedded(cx) {
        return crate::env::read_title_bar(cx);
    }
    let signal = windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.id == id)
        .map(|w| dup(cx, w.title_bar));
    match signal {
        Some(signal) => {
            let v = read(cx, signal);
            free(cx, signal);
            v
        }
        // Closed: none.
        None => {
            free(cx, read(cx, version(cx)));
            title_bar_value(cx, &Edges::default())
        }
    }
}

/// A `TitleBarArea` (owned).
fn title_bar_value(cx: *mut JsContext, area: &Edges<Points>) -> JsValue {
    let o = new_object(cx);
    set(cx, o, c"height", number(area.top.0.into()));
    set(cx, o, c"left", number(area.left.0.into()));
    set(cx, o, c"right", number(area.right.0.into()));
    o
}

/// `WindowRef.on(event, listener)`: a function that stops it, which goes
/// with the owner it was registered under.
fn on(cx: *mut JsContext, window: NodeId, event: JsValue, f: JsValue) -> JsValue {
    let name = dom::string_arg(cx, event);
    let Some(event) = name.as_deref().and_then(Event::parse) else {
        return type_error(
            cx,
            "WindowRef.on: the event is \"closePress\", \"close\", \"focusChange\", \"modeChange\", \"boundsChange\" or \"displayChange\"",
        );
    };
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsFunction(cx, f) } {
        return type_error(cx, "WindowRef.on: the listener is a function");
    }
    let id = add_listener(cx, window, event, dup(cx, f));
    let stop = native(cx, stop_listener, 0, 0, &mut [number(id as f64)]);
    if reactive::has_owner(cx) {
        reactive::add_cleanup(cx, dup(cx, stop));
    }
    stop
}

fn add_listener(cx: *mut JsContext, window: NodeId, event: Event, f: JsValue) -> u32 {
    let w = windows(cx);
    let id = w.next.get().wrapping_add(1);
    w.next.set(id);
    w.listeners.borrow_mut().push(Listener {
        id,
        window,
        event,
        f,
    });
    id
}

unsafe extern "C" fn stop_listener(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`on`).
    let id = as_number(cx, unsafe { *data }).unwrap_or(0.0) as u32;
    let removed = {
        let mut listeners = windows(cx).listeners.borrow_mut();
        listeners
            .iter()
            .position(|l| l.id == id)
            .map(|i| listeners.remove(i))
    };
    if let Some(l) = removed {
        free(cx, l.f);
    }
    UNDEFINED
}

/// Calls the listeners of `event` of window `window` with `payload` (owned).
fn fire(cx: *mut JsContext, window: NodeId, event: Event, payload: JsValue) {
    let fs: Vec<JsValue> = windows(cx)
        .listeners
        .borrow()
        .iter()
        .filter(|l| l.window == window && l.event == event)
        .map(|l| dup(cx, l.f))
        .collect();
    for f in fs {
        let mut args = [payload];
        let ok = reactive::untracked_with(cx, || call(cx, f, &mut args));
        if !ok {
            crate::web::js::report_exception(cx);
        }
        free(cx, f);
    }
    free(cx, payload);
}

/// Runs the listeners of what changed between two states of a window.
fn state_changed(
    cx: *mut JsContext,
    window: NodeId,
    old: Option<&WindowState>,
    new: Option<&WindowState>,
) {
    let (Some(old), Some(new)) = (old, new) else {
        return;
    };
    if old.focused != new.focused {
        let o = new_object(cx);
        set(cx, o, c"focused", boolean(new.focused));
        fire(cx, window, Event::FocusChange, o);
    }
    if old.mode != new.mode || old.minimized != new.minimized {
        let o = new_object(cx);
        set(cx, o, c"mode", encode(cx, &new.mode));
        set(cx, o, c"minimized", boolean(new.minimized));
        fire(cx, window, Event::ModeChange, o);
    }
    if old.bounds != new.bounds {
        let o = new_object(cx);
        set(cx, o, c"bounds", encode(cx, &new.bounds));
        fire(cx, window, Event::BoundsChange, o);
    }
    if old.display != new.display
        && let Some(id) = new.display
        && let Some(d) = crate::env::display_list(cx)
            .into_iter()
            .find(|d| d.id == id)
    {
        let o = new_object(cx);
        set(cx, o, c"display", encode(cx, &d));
        fire(cx, window, Event::DisplayChange, o);
    }
}

/// The displays changed: the states of the windows of the app's own give
/// their display's object again.
pub(crate) fn displays_changed(cx: *mut JsContext) {
    let states: Vec<(JsValue, WindowState)> = windows(cx)
        .list
        .borrow()
        .iter()
        .filter_map(|w| w.last.map(|state| (dup(cx, w.state), state)))
        .collect();
    for (signal, state) in states {
        reactive::set_signal(cx, signal, state_value(cx, Some(&state)));
        free(cx, signal);
    }
}

/// What the platform reports of a window of the app's own, or of the main
/// window (its close presses: its state is the environment's).
pub(crate) fn platform_event(cx: *mut JsContext, id: NodeId, event: &WindowEvent) {
    match event {
        WindowEvent::State(state) => {
            let state = **state;
            let (signal, previous) = {
                let mut list = windows(cx).list.borrow_mut();
                let Some(w) = list.iter_mut().find(|w| w.id == id) else {
                    return;
                };
                (dup(cx, w.state), w.last.replace(state))
            };
            reactive::set_signal(cx, signal, state_value(cx, Some(&state)));
            free(cx, signal);
            state_changed(cx, id, previous.as_ref(), Some(&state));
        }
        WindowEvent::TitleBar(area) => {
            let signal = windows(cx)
                .list
                .borrow()
                .iter()
                .find(|w| w.id == id)
                .map(|w| dup(cx, w.title_bar));
            let Some(signal) = signal else {
                return;
            };
            reactive::set_signal(cx, signal, title_bar_value(cx, area));
            free(cx, signal);
        }
        WindowEvent::ClosePress { reason } => {
            let o = new_object(cx);
            set(cx, o, c"reason", encode(cx, reason));
            fire(cx, id, Event::ClosePress, o);
        }
        WindowEvent::Closed { cause } => {
            if id != ROOT_ID {
                let r = close_own(cx, id, Some(*cause));
                if is_exception(r) {
                    crate::web::js::report_exception(cx);
                }
            }
        }
        // The root's: `Application`'s listeners hear them from the core.
        WindowEvent::QuitRequest | WindowEvent::Reopen => {}
    }
    let r = reactive::finish_value(cx, UNDEFINED);
    if is_exception(r) {
        crate::web::js::report_exception(cx);
    }
}

/// Closes window `id` of the app's own: by the app (`close()`, no `cause`)
/// or as the platform reports.
fn close_own(cx: *mut JsContext, id: NodeId, cause: Option<WindowCloseCause>) -> JsValue {
    enum Then {
        Opened(JsValue),
        Element(JsValue),
    }
    let then = {
        let list = windows(cx).list.borrow();
        let Some(w) = list.iter().find(|w| w.id == id) else {
            return UNDEFINED;
        };
        match &w.how {
            How::Opened { node, .. } => Then::Opened(dup(cx, *node)),
            How::Element { close, .. } => Then::Element(dup(cx, *close)),
        }
    };
    match then {
        Then::Opened(node) => {
            unregister(cx, id);
            let r = dom::remove_node(cx, dom::root_value(cx), node);
            free(cx, node);
            match r {
                Ok(()) => reactive::finish_value(cx, UNDEFINED),
                Err(e) => e,
            }
        }
        Then::Element(close) => {
            // The app's `close()`: `<Window>` reports it too.
            let reason = encode(cx, &cause.unwrap_or(WindowCloseCause::Close));
            let ok = call(cx, close, &mut [reason]);
            free(cx, reason);
            free(cx, close);
            if ok {
                reactive::finish_value(cx, UNDEFINED)
            } else {
                qjs::JS_EXCEPTION
            }
        }
    }
}

/// Takes window `id` out of the list: its state becomes `null`, its
/// `close` listeners run, the rest of its listeners go.
fn unregister(cx: *mut JsContext, id: NodeId) {
    let removed = {
        let mut list = windows(cx).list.borrow_mut();
        list.iter().position(|w| w.id == id).map(|i| list.remove(i))
    };
    let Some(w) = removed else {
        return;
    };
    reactive::set_signal(cx, w.state, qjs::JS_NULL);
    bump(cx);
    fire(cx, id, Event::Close, UNDEFINED);
    let gone: Vec<Listener> = {
        let mut listeners = windows(cx).listeners.borrow_mut();
        let (gone, kept) = listeners.drain(..).partition(|l| l.window == id);
        *listeners = kept;
        gone
    };
    for l in gone {
        free(cx, l.f);
    }
    free(cx, w.handle);
    free(cx, w.state);
    free(cx, w.title_bar);
    match w.how {
        // The caller removes the node; its content's signals, effects and
        // bindings go with the window.
        How::Opened { node, owner } => {
            free(cx, node);
            reactive::dispose_owner(cx, owner);
        }
        How::Element { close, owner } => {
            free(cx, close);
            // Its content's signals, effects and bindings go with it.
            reactive::dispose_owner(cx, owner);
        }
    }
}

// --- Opening ---------------------------------------------------------------------------

/// The options' checks shared by `<Window>` and `Window.open`: decoded,
/// on a desktop, granted by the app's capabilities. Throws otherwise.
fn checked_options(cx: *mut JsContext, what: &str, o: JsValue) -> Result<WindowOptions, JsValue> {
    if !windows_supported(cx) {
        let error = JsError::Error(format!(
            "{what}: windows of the app's own open on the desktops (`isAvailable`)"
        ))
        .with_code(codes::UNAVAILABLE);
        return Err(throw(cx, error));
    }
    let options =
        decode::<WindowOptions>(cx, o).map_err(|e| type_error(cx, &format!("{what}: {e}")))?;
    let open = windows(cx).list.borrow().len();
    let checked = crate::dom::shared(cx).system_access.borrow().check_window(
        options.kind,
        &options.attributes,
        open,
    );
    if let Err(message) = checked {
        let error =
            JsError::access_denied(format!("{what}: {message}"), "windows", options.id.clone());
        return Err(throw(cx, error));
    }
    Ok(options)
}

/// Opens a dialog root for `options` and lists it: the new node (owned),
/// its id and its handle (owned).
fn open_node(
    cx: *mut JsContext,
    options: WindowOptions,
    how: impl FnOnce(JsValue) -> How,
) -> Result<(JsValue, NodeId, JsValue), JsValue> {
    let node = dom::create_element(cx, Tag::Modal)?;
    let Some(id) = dom::node_id(cx, node) else {
        free(cx, node);
        return Err(type_error(cx, "Window: no node"));
    };
    let parent = options
        .parent
        .as_deref()
        .and_then(|p| node_of_key(cx, p))
        .and_then(|p| handle_of(cx, p))
        .unwrap_or(qjs::JS_NULL);
    let key = options.id.clone();
    let mut open = OpenWindow::default();
    open.options = options;
    if let Err(e) = send(cx, id, DesktopCommand::OpenWindow(Box::new(open))) {
        free(cx, parent);
        free(cx, node);
        return Err(e);
    }
    let handle = make_handle(cx, &key, id, parent);
    free(cx, parent);
    // The platforms that close windows themselves report it so.
    let dismissed = native(cx, on_dismiss, 0, 0, &mut [number(id as f64)]);
    let r = dom::set_handler(cx, id, EventKind::Dismiss, dismissed);
    free(cx, dismissed);
    if let Err(e) = r {
        free(cx, handle);
        free(cx, node);
        return Err(e);
    }
    windows(cx).list.borrow_mut().push(Own {
        key,
        id,
        handle: dup(cx, handle),
        state: reactive::new_signal(cx, qjs::JS_NULL),
        last: None,
        title_bar: {
            let zeros = title_bar_value(cx, &Edges::default());
            let signal = reactive::new_signal(cx, zeros);
            free(cx, zeros);
            signal
        },
        how: how(node),
    });
    bump(cx);
    Ok((node, id, handle))
}

/// The first window a desktop app that declares none renders in: its
/// released main window. `mount` opens it before the app root renders (so
/// `currentWindow()` in the root is it) and closes it unshown when the
/// root turns out to declare `<Window>` scenes of its own.
pub(crate) struct Implicit {
    /// Its root node (owned), which `mount` inserts into the app root
    /// before the root renders: the app root's content inserts into it, so
    /// its dynamics keep updating the window.
    pub(crate) node: JsValue,
    /// Its `WindowRef` (owned), listed when it opens.
    handle: JsValue,
    id: NodeId,
}

/// Declares the implicit first window (`id` "main"), pending: it is
/// opened when the app root turns out to return plain content, and its
/// `WindowRef` is the window of the render in progress (released apps
/// call `currentWindow()` in the root).
pub(crate) fn begin_implicit(cx: *mut JsContext) -> Result<Implicit, JsValue> {
    let node = dom::create_element(cx, Tag::Modal)?;
    let Some(id) = dom::node_id(cx, node) else {
        free(cx, node);
        return Err(type_error(cx, "mount: no node for the first window"));
    };
    let handle = make_handle(cx, "main", id, qjs::JS_NULL);
    // Not a window `keymap.bind` scopes to: a released app's root bindings
    // stay app-wide, as the old model's were.
    set(cx, handle, c"implicit", qjs::JS_TRUE);
    *windows(cx).pending.borrow_mut() = Some((id, WindowAttributes::default(), Vec::new()));
    reactive::provide(cx, context_key(cx), handle);
    Ok(Implicit { node, handle, id })
}

/// Drops the implicit first window, unopened: the app declared windows of
/// its own, so it never was the app's. Its node leaves the app root.
pub(crate) fn discard_implicit(cx: *mut JsContext, implicit: Implicit) {
    windows(cx).pending.borrow_mut().take();
    let _ = dom::remove_node(cx, dom::root_value(cx), implicit.node);
    free(cx, implicit.node);
    // Its ref stays alive: the app root's context points at it.
    windows(cx).unopened.borrow_mut().push(implicit.handle);
}

/// Keeps the implicit first window unopened: the app declares `<Window>`
/// scenes of its own, whose nodes were inserted into its node (the app
/// root's only content). The node stays in the app root as their home.
pub(crate) fn forget_implicit(cx: *mut JsContext, implicit: Implicit) {
    windows(cx).pending.borrow_mut().take();
    // The app root's context points at its ref.
    windows(cx).unopened.borrow_mut().push(implicit.handle);
    free(cx, implicit.node);
}

/// Opens the implicit first window, around its node in the app root, with
/// what the app set and asked while it rendered. `mount_owner` is the
/// root owner: the window goes when the mount does.
pub(crate) fn finish_implicit(cx: *mut JsContext, implicit: Implicit, mount_owner: u32) {
    let (attributes, requests) = windows(cx).pending.borrow_mut().take().map_or_else(
        || (WindowAttributes::default(), Vec::new()),
        |(_, attributes, requests)| (attributes, requests),
    );
    let mut options = WindowOptions::default();
    options.id = "main".to_owned();
    options.attributes = attributes;
    let mut open = OpenWindow::default();
    // The first window of a released app is not a window of its own for
    // `capabilities.windows`: the old main window needed no grant.
    open.implicit = true;
    open.options = options;
    if let Err(e) = send(cx, implicit.id, DesktopCommand::OpenWindow(Box::new(open))) {
        // The app root's context points at its ref.
        windows(cx).unopened.borrow_mut().push(implicit.handle);
        free(cx, e);
        return;
    }
    for request in requests {
        if let Err(e) = send(cx, implicit.id, DesktopCommand::Request(request)) {
            free(cx, e);
        }
    }
    let (owner, ()) = reactive::with_root(cx, || ());
    windows(cx).list.borrow_mut().push(Own {
        key: "main".to_owned(),
        id: implicit.id,
        handle: implicit.handle,
        state: reactive::new_signal(cx, qjs::JS_NULL),
        last: None,
        title_bar: {
            let zeros = title_bar_value(cx, &Edges::default());
            let signal = reactive::new_signal(cx, zeros);
            free(cx, zeros);
            signal
        },
        how: How::Opened {
            node: dup(cx, implicit.node),
            owner,
        },
    });
    // Unmounted (closed, hot reloaded or disposed): out of the list. The
    // cleanup belongs to the mount's owner, not the ambient one.
    reactive::with_root_under(cx, mount_owner, || {
        reactive::add_cleanup(
            cx,
            native(cx, element_gone, 0, 0, &mut [number(implicit.id as f64)]),
        );
    });
    bump(cx);
    free(cx, implicit.node);
}

/// A window's `onDismiss`: the user closed it.
unsafe extern "C" fn on_dismiss(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (`open_node`).
    let id = as_number(cx, unsafe { *data }).unwrap_or(0.0) as NodeId;
    close_own(cx, id, Some(WindowCloseCause::ClosePress))
}

/// `Window.open(Component, options)`: renders `Component` in a window of
/// its own; the open window of the same `id`, if there is one.
unsafe extern "C" fn open_window(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let (component, o) = (arg(argc, argv, 0), arg(argc, argv, 1));
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsFunction(cx, component) } {
        return type_error(cx, "Window.open: the first argument is a component");
    }
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsObject(o) } {
        return type_error(cx, "Window.open: options with an id");
    }
    let id = get(cx, o, c"id");
    let key = dom::string_arg(cx, id);
    free(cx, id);
    if let Some(open) = key.as_deref().and_then(|k| node_of_key(cx, k))
        && let Some(handle) = handle_of(cx, open)
    {
        // Opening an open window brings it forward, as apps expect.
        if let Err(e) = send(cx, open, DesktopCommand::Request(WindowRequest::Focus)) {
            free(cx, handle);
            return e;
        }
        return handle;
    }
    let options = match checked_options(cx, "Window.open", o) {
        Ok(options) => options,
        Err(e) => return e,
    };
    let (node, id, handle) = match open_node(cx, options, |node| How::Opened {
        node: dup(cx, node),
        owner: 0,
    }) {
        Ok(opened) => opened,
        Err(e) => return e,
    };
    let (owner, rendered) = reactive::with_root(cx, || {
        reactive::provide(cx, context_key(cx), handle);
        let mut args = [new_object(cx)];
        let out = reactive::untracked_with(cx, || {
            // SAFETY: a call of the component with a new props object.
            unsafe { qjs::JS_Call(cx, component, UNDEFINED, 1, args.as_mut_ptr()) }
        });
        free(cx, args[0]);
        if is_exception(out) {
            return Err(out);
        }
        let r = dom::insert_value_at(cx, node, out, None);
        free(cx, out);
        r
    });
    if let Some(w) = windows(cx)
        .list
        .borrow_mut()
        .iter_mut()
        .find(|w| w.id == id)
        && let How::Opened { owner: o, .. } = &mut w.how
    {
        *o = owner;
    }
    let inserted = rendered.and_then(|()| dom::insert_node(cx, dom::root_value(cx), node, None));
    free(cx, node);
    if let Err(e) = inserted {
        reactive::dispose_owner(cx, owner);
        unregister(cx, id);
        free(cx, handle);
        return e;
    }
    reactive::finish_value(cx, handle)
}

/// `Window.get(id)`: the open window with `id` (`"main"`: the main
/// window), or `null`.
unsafe extern "C" fn get_window(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(key) = dom::string_arg(cx, arg(argc, argv, 0)) else {
        return type_error(cx, "Window.get: the id is a string");
    };
    // Tracked: a window opening or closing changes the answer.
    free(cx, read(cx, version(cx)));
    if let Some(handle) = node_of_key(cx, &key).and_then(|id| handle_of(cx, id)) {
        return handle;
    }
    qjs::JS_NULL
}

// --- <Window> ----------------------------------------------------------------------------

/// `<Window id kind open onOpenChange …>`: a window of the app's own while
/// it is open: `open` is not false and the user did not close it. It is a
/// top-level scene of the app root on the desktops. Elsewhere (iOS, Android,
/// the web) it degrades to its content in the app's one window.
unsafe extern "C" fn window_component(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    // The app root declares the app's windows, open or not: `mount` makes
    // no implicit first window for a root that does.
    dom::note_declared_window(cx);
    // A terminal app fills the terminal: its one surface is the app's, as
    // on the phones and the web, and no window root is made.
    if !windows_supported(cx) {
        // One surface: the scene is its content while `open`, and follows
        // `open` as a scene does on the desktops.
        let run = native(cx, mobile_window_run, 0, 0, &mut [props]);
        let shown = reactive::memo(cx, run, false);
        return reactive::finish_value(cx, shown);
    }
    // A `<Window>` is a scene wherever it is declared: a top-level one
    // belongs to the app root, a nested one to the window around it (it
    // closes with it). It is never inserted as a view in its parent.
    // Closed by the user while `open` stayed true: `closed` (a plain
    // object's flag) and `tick`, which runs the memo again.
    let state = new_object(cx);
    let tick = reactive::new_signal(cx, number(0.0));
    let run = native(cx, window_run, 0, 0, &mut [props, state, tick]);
    free(cx, state);
    free(cx, tick);
    let shown = reactive::memo(cx, run, false);
    reactive::finish_value(cx, shown)
}

/// `<Window>`'s scene off the desktops: its content while open, else null.
unsafe extern "C" fn mobile_window_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (props).
    let props = unsafe { *data };
    if !window_is_open(cx, props) {
        return qjs::JS_NULL;
    }
    get(cx, props, c"children")
}

/// Whether a `<Window>`'s `open` (or `defaultOpen`) lets it open.
fn window_is_open(cx: *mut JsContext, props: JsValue) -> bool {
    let open = get(cx, props, c"open");
    if nullish(open) {
        let default = get(cx, props, c"defaultOpen");
        // SAFETY: an inline check of a live value.
        let closed = unsafe { qjs::JS_IsBool(default) } && !truthy(cx, default);
        free(cx, default);
        !closed
    } else {
        let on = truthy(cx, open);
        free(cx, open);
        on
    }
}

fn flag(cx: *mut JsContext, state: JsValue, key: &CStr) -> bool {
    let v = get(cx, state, key);
    let on = truthy(cx, v);
    free(cx, v);
    on
}

/// `<Window>`'s memo: its dialog root while it is open, else `null`.
unsafe extern "C" fn window_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick).
    let (props, state, tick) = unsafe { (*data, *data.add(1), *data.add(2)) };
    free(cx, read(cx, tick));
    let open = window_is_open(cx, props);
    if !open {
        // The app followed (or closed it itself): the next `open` opens it.
        set(cx, state, c"closed", qjs::JS_FALSE);
        return qjs::JS_NULL;
    }
    if flag(cx, state, c"closed") {
        return qjs::JS_NULL;
    }
    reactive::untracked_with(cx, || {
        let options = match checked_options(cx, "<Window>", props) {
            Ok(options) => options,
            Err(e) => return e,
        };
        if is_embedded(cx) && options.id == "main" {
            let handle = main_ref(cx);
            reactive::provide(cx, context_key(cx), handle);
            let target = get(cx, props, c"ref");
            let r = dom::apply_ref(cx, target, handle);
            free(cx, target);
            free(cx, handle);
            if let Err(e) = r {
                return e;
            }
            for (prop, event) in [
                (c"onFocusChange", Event::FocusChange),
                (c"onModeChange", Event::ModeChange),
                (c"onBoundsChange", Event::BoundsChange),
                (c"onDisplayChange", Event::DisplayChange),
                (c"onClosePress", Event::ClosePress),
            ] {
                let name = string(cx, prop.to_str().unwrap_or(""));
                let f = native(cx, call_prop, 1, 0, &mut [props, name]);
                free(cx, name);
                let lid = add_listener(cx, ROOT_ID, event, f);
                let stop = native(cx, stop_listener, 0, 0, &mut [number(lid as f64)]);
                reactive::add_cleanup(cx, stop);
            }
            let effect = native(
                cx,
                attributes_effect,
                0,
                0,
                &mut [props, number(ROOT_ID as f64)],
            );
            free(cx, reactive::render_effect(cx, effect));
            return get(cx, props, c"children");
        }
        if node_of_key(cx, &options.id).is_some() {
            log::warn!(
                target: "js",
                "<Window>: a window with id {:?} is open already; one window per id",
                options.id
            );
            return qjs::JS_NULL;
        }
        let close = native(cx, element_close, 1, 0, &mut [props, state, tick]);
        // The window's content lives in a root of its own: closing the
        // window disposes its signals, effects and bindings, and the app
        // root's state stays.
        let (owner, ()) = reactive::with_root(cx, || ());
        let opened = open_node(cx, options, |_| How::Element { close, owner });
        let (node, id, handle) = match opened {
            Ok(opened) => opened,
            Err(e) => {
                reactive::dispose_owner(cx, owner);
                return e;
            }
        };
        // The memo's cleanup runs when the element closes: `element_gone`
        // unregisters the window and disposes its root.
        reactive::add_cleanup(cx, native(cx, element_gone, 0, 0, &mut [number(id as f64)]));
        let (_, result) = reactive::with_root_under(cx, owner, || -> Result<(), JsValue> {
            reactive::provide(cx, context_key(cx), handle);
            // `ref`: the window's `WindowRef` (a variable's assignment, a
            // signal or a function, as the compiler gives it).
            let target = get(cx, props, c"ref");
            let r = dom::apply_ref(cx, target, handle);
            free(cx, target);
            r?;
            for (prop, event) in [
                (c"onFocusChange", Event::FocusChange),
                (c"onModeChange", Event::ModeChange),
                (c"onBoundsChange", Event::BoundsChange),
                (c"onDisplayChange", Event::DisplayChange),
                (c"onClosePress", Event::ClosePress),
            ] {
                let name = string(cx, prop.to_str().unwrap_or(""));
                let f = native(cx, call_prop, 1, 0, &mut [props, name]);
                free(cx, name);
                add_listener(cx, id, event, f);
            }
            // The attributes follow the props (the core sends what changed).
            let effect = native(cx, attributes_effect, 0, 0, &mut [props, number(id as f64)]);
            free(cx, reactive::render_effect(cx, effect));
            let children = get(cx, props, c"children");
            let r = dom::insert_value_at(cx, node, children, None);
            free(cx, children);
            r
        });
        free(cx, handle);
        match result {
            Ok(()) => node,
            Err(e) => {
                unregister(cx, id);
                free(cx, node);
                e
            }
        }
    })
}

/// Calls `props[name]` (data: props, name) with the event, if it is set.
unsafe extern "C" fn call_prop(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (props, name).
    let (props, name) = unsafe { (*data, *data.add(1)) };
    let Some(name) = dom::string_arg(cx, name) else {
        return UNDEFINED;
    };
    let Ok(name) = std::ffi::CString::new(name) else {
        return UNDEFINED;
    };
    let f = get(cx, props, &name);
    // SAFETY: an inline check.
    let r = if unsafe { qjs::JS_IsFunction(cx, f) } {
        let mut args = [arg(argc, argv, 0)];
        // SAFETY: a call of the app's function with a borrowed argument.
        unsafe { qjs::JS_Call(cx, f, UNDEFINED, 1, args.as_mut_ptr()) }
    } else {
        UNDEFINED
    };
    free(cx, f);
    r
}

/// `<Window>`'s attributes, sent again when the props they read change.
unsafe extern "C" fn attributes_effect(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (props, node id).
    let (props, id) = unsafe { (*data, *data.add(1)) };
    let id = as_number(cx, id).unwrap_or(0.0) as NodeId;
    match decode::<WindowAttributes>(cx, props) {
        Ok(attributes) if !attributes.is_empty() => {
            match send(cx, id, DesktopCommand::SetAttributes(Box::new(attributes))) {
                Ok(()) => UNDEFINED,
                Err(e) => e,
            }
        }
        Ok(_) => UNDEFINED,
        Err(e) => {
            log::warn!(target: "js", "<Window>: {e}");
            UNDEFINED
        }
    }
}

/// `<Window>` closed without the app closing it (data: props, state,
/// tick; argument: the reason's name): hidden until the app follows, and
/// `onOpenChange({ open: false, reason })`.
unsafe extern "C" fn element_close(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick).
    let (props, state, tick) = unsafe { (*data, *data.add(1), *data.add(2)) };
    set(cx, state, c"closed", qjs::JS_TRUE);
    let n = reactive::peek_number(cx, tick).unwrap_or(0.0);
    reactive::set_signal(cx, tick, number(n + 1.0));
    let f = get(cx, props, c"onOpenChange");
    // SAFETY: an inline check.
    let r = if unsafe { qjs::JS_IsFunction(cx, f) } {
        let event = new_object(cx);
        set(cx, event, c"open", qjs::JS_FALSE);
        set(cx, event, c"reason", dup(cx, arg(argc, argv, 0)));
        let mut args = [event];
        // SAFETY: a call of the app's function with a borrowed argument.
        let r = unsafe { qjs::JS_Call(cx, f, UNDEFINED, 1, args.as_mut_ptr()) };
        free(cx, event);
        r
    } else {
        UNDEFINED
    };
    free(cx, f);
    r
}

/// `<Window>`'s cleanup: it closed or unmounted.
unsafe extern "C" fn element_gone(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the node id).
    let id = as_number(cx, unsafe { *data }).unwrap_or(0.0) as NodeId;
    unregister(cx, id);
    UNDEFINED
}

// --- Exports ---------------------------------------------------------------------------

/// `Window`: the component, with `open` and `get`.
pub(crate) fn window_export(cx: *mut JsContext) -> JsValue {
    let window = reactive::new_function(cx, c"Window", window_component, 1);
    let open = reactive::new_function(cx, c"open", open_window, 2);
    set(cx, window, c"open", open);
    let get = reactive::new_function(cx, c"get", get_window, 1);
    set(cx, window, c"get", get);
    window
}

/// The window the calling code renders in (owned); `None` outside a
/// reactive owner. In the app root it is the host surface when inline,
/// otherwise the main window as released apps expect.
fn current(cx: *mut JsContext) -> Option<JsValue> {
    if !reactive::has_owner(cx) {
        return None;
    }
    Some(reactive::lookup(cx, context_key(cx)).unwrap_or_else(|| {
        if dom::inline_root(cx) {
            surface_ref(cx)
        } else {
            main_ref(cx)
        }
    }))
}

/// The root node of the focused window of the app's own, if one has the
/// keyboard focus. App-level popups act in that window, not the hidden host.
pub(crate) fn focused_node(cx: *mut JsContext) -> Option<NodeId> {
    windows(cx)
        .list
        .borrow()
        .iter()
        .find(|w| w.last.as_ref().is_some_and(|state| state.focused))
        .map(|w| w.id)
}

/// Whether the platform has windows at all: the desktops, but not a
/// terminal app, which fills the terminal with its one surface.
pub(crate) fn windows_supported(cx: *mut JsContext) -> bool {
    let env = crate::env::current(cx);
    env.os.is_desktop() && env.idiom != nsh_core::platform::Idiom::Terminal
}

/// `currentWindow()`.
pub(crate) unsafe extern "C" fn current_window(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    current(cx).unwrap_or_else(|| {
        type_error(
            cx,
            "currentWindow() reads the window a component renders in: call it while rendering and keep the WindowRef it returns",
        )
    })
}

/// `windows()`: the app's windows in opening order (tracked).
pub(crate) unsafe extern "C" fn all_windows(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    free(cx, read(cx, version(cx)));
    let mut handles: Vec<JsValue> = Vec::new();
    // Off the desktops the app's one surface is its main window, first as
    // the old model listed it.
    if !windows_supported(cx) {
        handles.push(main_ref(cx));
    }
    handles.extend(windows(cx).list.borrow().iter().map(|w| dup(cx, w.handle)));
    // SAFETY: a new array taking the handles.
    unsafe { qjs::JS_NewArrayFrom(cx, handles.len() as c_int, handles.as_mut_ptr()) }
}

/// `focusedWindow()`: the window with the keyboard focus, or `null`
/// (tracked).
pub(crate) unsafe extern "C" fn focused_window(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    free(cx, read(cx, version(cx)));
    let ids: Vec<NodeId> = windows(cx).list.borrow().iter().map(|w| w.id).collect();
    let mut focused = None;
    // Every state is read, so a change of any of them runs the reader again.
    for id in ids {
        let state = state_of(cx, id);
        let f = get(cx, state, c"focused");
        if focused.is_none() && truthy(cx, f) {
            focused = Some(id);
        }
        free(cx, f);
        free(cx, state);
    }
    focused
        .and_then(|id| handle_of(cx, id))
        .unwrap_or(qjs::JS_NULL)
}

/// `windowState()`: the current window's state (tracked).
pub(crate) unsafe extern "C" fn window_state(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    if !windows_supported(cx) {
        return qjs::JS_NULL;
    }
    let Some(id) = current_ref_id(cx) else {
        return type_error(
            cx,
            "windowState() reads the current window: call it inside <Window>, or use focusedWindow()/windows() in the app root",
        );
    };
    state_of(cx, id)
}

/// `titleBar()`: the current window's title bar area (tracked).
pub(crate) unsafe extern "C" fn title_bar(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    if !windows_supported(cx) {
        return title_bar_value(cx, &Edges::default());
    }
    let Some(id) = current_ref_id(cx) else {
        return type_error(
            cx,
            "titleBar() reads the current window: call it inside <Window>, or use focusedWindow()/windows() in the app root",
        );
    };
    title_bar_of(cx, id)
}

/// The node of the window code renders in, if any (`keymap.bind`'s
/// default scope).
pub(crate) fn current_node(cx: *mut JsContext) -> Option<NodeId> {
    current_id(cx)
}

/// The node of the window the code renders in, if it renders inside one:
/// the context a `<Window>` provides, not the app root's main window
/// (`current`), so bindings at the app root stay app-wide as released
/// apps made them.
fn current_id(cx: *mut JsContext) -> Option<NodeId> {
    if !reactive::has_owner(cx) {
        return None;
    }
    let handle = reactive::lookup(cx, context_key(cx))?;
    let implicit = get(cx, handle, c"implicit");
    let is_implicit = truthy(cx, implicit);
    free(cx, implicit);
    if is_implicit {
        free(cx, handle);
        return None;
    }
    let id = key_node(cx, handle);
    free(cx, handle);
    id
}

/// The node of the window the code renders in, the implicit first window
/// included (`windowState`, `titleBar`): while the app root renders it is
/// the pending window, and where the root declares windows it is the
/// window named `"main"`, if the app has one open.
fn current_ref_id(cx: *mut JsContext) -> Option<NodeId> {
    if !reactive::has_owner(cx) {
        return None;
    }
    let Some(handle) = reactive::lookup(cx, context_key(cx)) else {
        return is_embedded(cx).then_some(ROOT_ID);
    };
    let pending = {
        let implicit = get(cx, handle, c"implicit");
        let is_implicit = truthy(cx, implicit);
        free(cx, implicit);
        if is_implicit {
            windows(cx).pending.borrow().as_ref().map(|(id, _, _)| *id)
        } else {
            None
        }
    };
    let id = pending.or_else(|| key_node(cx, handle));
    free(cx, handle);
    id
}

/// The node of the window `handle` names, if it is open.
fn key_node(cx: *mut JsContext, handle: JsValue) -> Option<NodeId> {
    let id = get(cx, handle, c"id");
    let key = dom::string_arg(cx, id);
    free(cx, id);
    key.and_then(|k| node_of_key(cx, &k))
}
