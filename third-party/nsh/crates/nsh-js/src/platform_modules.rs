//! The small runtime modules: `nsh/android`
//! (`isAvailable`, `BackHandler.onBackPress` over the registry's module),
//! `nsh/ios` (`isAvailable`, `InputAccessoryView`), `nsh/mobile`
//! (`isAvailable`, with the registry's `TabBar`), `nsh/webview` and
//! `nsh/video` (their host elements as components, which the compiler
//! makes in place for their tags), `nsh/native` (`nativeComponent`: the
//! JS face of components the embedding app registers natively;
//! `nativeModule`: the exports of a UI set it registers, reached by name at
//! run time) and `nsh/host` (`available()` and the host's events over the
//! registry's `call`).

use std::{
    cell::RefCell,
    ffi::{CStr, CString, c_int},
    ptr,
};

use nsh_core::{EventKind, Tag, platform::Os};
use rquickjs::qjs;

use crate::{
    dom,
    modules::{Export, Item, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The modules' part of a context's state.
#[derive(Default)]
pub(crate) struct PlatformModules {
    /// `BackHandler.onBackPress` listeners, in order (id, owned
    /// function).
    back: RefCell<Vec<(u32, JsValue)>>,
    /// `host.on` listeners, in order (id, event, owned function).
    host_listeners: RefCell<Vec<(u32, String, JsValue)>>,
    next: std::cell::Cell<u32>,
}

impl PlatformModules {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        for (_, f) in self.back.borrow_mut().drain(..) {
            // SAFETY: owned values; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, f) };
        }
        for (_, _, f) in self.host_listeners.borrow_mut().drain(..) {
            // SAFETY: as above.
            unsafe { qjs::JS_FreeValue(raw, f) };
        }
    }
}

fn modules<'a>(cx: *mut JsContext) -> &'a PlatformModules {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).platform }
}

fn os(cx: *mut JsContext) -> Os {
    // SAFETY: the state's renderer, by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }.os()
}

fn boolean(v: bool) -> JsValue {
    if v { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

type DataFn = unsafe extern "C" fn(
    *mut JsContext,
    JsValue,
    c_int,
    *mut JsValue,
    c_int,
    *mut JsValue,
) -> JsValue;

fn native(cx: *mut JsContext, f: DataFn, length: c_int, data: &mut [JsValue]) -> JsValue {
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

/// A component that renders nothing (`InputAccessoryView` off iOS).
unsafe extern "C" fn nothing(
    _cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    qjs::JS_NULL
}

// --- nsh/android ------------------------------------------------------------------------

/// `BackHandler`: the registry's module (`exitApp`) with listeners of the
/// hardware back button.
fn back_handler(cx: *mut JsContext) -> JsValue {
    let handler = crate::components::runtime_module(cx, "nsh/android", "BackHandler")
        // SAFETY: a new object when the runtime has none.
        .unwrap_or_else(|| unsafe { qjs::JS_NewObject(cx) });
    let add = reactive::new_function(cx, c"onBackPress", add_back_listener, 1);
    // SAFETY: the object takes the function.
    unsafe { qjs::JS_SetPropertyStr(cx, handler, c"onBackPress".as_ptr(), add) };
    handler
}

/// `BackHandler.onBackPress(f)`: a function that removes the listener,
/// which goes by itself with the owner it was added under (the component
/// rendering), or when hot module replacement runs the module that added
/// it again.
unsafe extern "C" fn add_back_listener(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let f = arg(argc, argv, 0);
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsFunction(cx, f) } {
        return unsafe { qjs::JS_ThrowTypeError(cx, c"onBackPress: a function".as_ptr()) };
    }
    let m = modules(cx);
    let id = m.next.get() + 1;
    m.next.set(id);
    // SAFETY: a dup the listeners own.
    let first = {
        let mut back = m.back.borrow_mut();
        back.push((id, unsafe { qjs::JS_DupValue(cx, f) }));
        back.len() == 1
    };
    if first {
        let on = reactive::new_function(cx, c"onBackPress", on_back_press, 0);
        let r = dom::set_handler(cx, 1, EventKind::BackPress, on);
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, on) };
        if let Err(e) = r {
            return e;
        }
    }
    let remove = native(
        cx,
        remove_back_listener,
        0,
        &mut [qjs::JS_NewFloat64(id as f64)],
    );
    let remove = crate::web::js::V::own(cx, remove);
    crate::keymap::undo_with_owner(cx, &remove);
    remove.take()
}

unsafe extern "C" fn remove_back_listener(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0f64;
    // SAFETY: one data value, the listener's id.
    unsafe { qjs::JS_ToFloat64(cx, &mut id, *data) };
    let (gone, empty) = {
        let mut back = modules(cx).back.borrow_mut();
        let i = back.iter().position(|(i, _)| *i == id as u32);
        (i.map(|i| back.remove(i).1), back.is_empty())
    };
    if let Some(f) = gone {
        // SAFETY: owned.
        unsafe { qjs::JS_FreeValue(cx, f) };
        if empty {
            let _ = dom::set_handler(cx, 1, EventKind::BackPress, UNDEFINED);
        }
    }
    UNDEFINED
}

/// The back button: the newest listener first; when none handles it (`true`
/// handles), the platform goes back as without listeners (a stack pops, or
/// the app leaves).
unsafe extern "C" fn on_back_press(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let listeners: Vec<JsValue> = modules(cx)
        .back
        .borrow()
        .iter()
        .rev()
        // SAFETY: dups for the calls.
        .map(|&(_, f)| unsafe { qjs::JS_DupValue(cx, f) })
        .collect();
    let mut handled = false;
    let mut failed = None;
    for f in listeners {
        if !handled && failed.is_none() {
            // SAFETY: a call of an owned function, then its result.
            unsafe {
                let r = qjs::JS_Call(cx, f, UNDEFINED, 0, ptr::null_mut());
                if qjs::JS_IsException(r) {
                    failed = Some(r);
                } else {
                    handled = qjs::JS_ToBool(cx, r) == 1;
                    qjs::JS_FreeValue(cx, r);
                }
            }
        }
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, f) };
    }
    if let Some(e) = failed {
        return e;
    }
    if handled {
        return UNDEFINED;
    }
    match dom::push_op(
        cx,
        nsh_core::Op::Command {
            id: 1,
            command: nsh_core::Command::Back,
        },
    ) {
        Ok(()) => UNDEFINED,
        Err(e) => e,
    }
}

/// The hand-written exports of `nsh/android` (with the registry's).
pub(crate) const ANDROID_EXPORTS: &[Item] = &[
    (
        "isAvailable",
        Export::Value(|cx| boolean(os(cx) == Os::Android)),
        Ts::value("True on Android.", "boolean"),
    ),
    (
        "BackHandler",
        Export::Value(back_handler),
        Ts::value(
            "The Android back button: its listeners run after modals and before\nstacks.",
            "BackHandlerModule & BackListeners",
        ),
    ),
];

/// `nsh/android`'s types (with the runtime registry's modules).
pub(crate) const ANDROID_TYPES: &str = r#"/** The back button's listeners. */
export interface BackListeners {
  /** Listens to the back button: `listener` returns true when it handled
   * the press; the most recently added listener runs first, after modals
   * and before stacks. Without a listener that handles it, the top stack
   * pops, else the app exits. The returned function stops listening; a
   * listener added while a component renders stops with the component. */
  onBackPress(listener: () => boolean | void): () => void;
}
"#;

// --- nsh/host ---------------------------------------------------------------------------

/// `host`: the registry's module (`call`) with `available()` and the
/// listeners of the host's events.
fn host_module(ctx: *mut JsContext) -> JsValue {
    let host = crate::components::runtime_module(ctx, "nsh/host", "host")
        // SAFETY: a new object when the runtime has none.
        .unwrap_or_else(|| unsafe { qjs::JS_NewObject(ctx) });
    let natives: [(&CStr, reactive::Native, c_int); 2] = [
        (c"available", host_available, 0),
        (c"on", add_host_listener, 2),
    ];
    for (name, f, length) in natives {
        let func = reactive::new_function(ctx, name, f, length);
        // SAFETY: the object takes the function.
        unsafe { qjs::JS_SetPropertyStr(ctx, host, name.as_ptr(), func) };
    }
    crate::host_channel::extend(ctx, host)
}

/// `host.available()`: whether the platform embeds a host that answers
/// calls (read when called: the environment may change).
unsafe extern "C" fn host_available(
    ctx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    boolean(crate::env::current(ctx).host || crate::host_channel::available(ctx))
}

/// `host.on(event, listener)`: `{ remove() }`.
unsafe extern "C" fn add_host_listener(
    ctx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(event) = dom::string_arg(ctx, arg(argc, argv, 0)) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(ctx, c"host.on: an event name".as_ptr()) };
    };
    let f = arg(argc, argv, 1);
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsFunction(ctx, f) } {
        return unsafe { qjs::JS_ThrowTypeError(ctx, c"host.on: a function".as_ptr()) };
    }
    let m = modules(ctx);
    let id = m.next.get() + 1;
    m.next.set(id);
    // SAFETY: a dup the listeners own.
    let first = {
        let mut host = m.host_listeners.borrow_mut();
        host.push((id, event, unsafe { qjs::JS_DupValue(ctx, f) }));
        host.len() == 1
    };
    if first {
        let on = reactive::new_function(ctx, c"onHost", on_host_event, 1);
        let r = dom::set_handler(ctx, 1, EventKind::Host, on);
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(ctx, on) };
        if let Err(e) = r {
            return e;
        }
    }
    let remove = native(
        ctx,
        remove_host_listener,
        0,
        &mut [qjs::JS_NewFloat64(id as f64)],
    );
    // SAFETY: a new object taking the function.
    unsafe {
        let o = qjs::JS_NewObject(ctx);
        qjs::JS_SetPropertyStr(ctx, o, c"remove".as_ptr(), remove);
        o
    }
}

unsafe extern "C" fn remove_host_listener(
    ctx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0f64;
    // SAFETY: one data value, the listener's id.
    unsafe { qjs::JS_ToFloat64(ctx, &mut id, *data) };
    let (gone, empty) = {
        let mut host = modules(ctx).host_listeners.borrow_mut();
        let i = host.iter().position(|(i, ..)| *i == id as u32);
        (i.map(|i| host.remove(i).2), host.is_empty())
    };
    if let Some(f) = gone {
        // SAFETY: owned.
        unsafe { qjs::JS_FreeValue(ctx, f) };
        if empty {
            let _ = dom::set_handler(ctx, 1, EventKind::Host, UNDEFINED);
        }
    }
    UNDEFINED
}

/// The root's `Host` events of `type: "event"` (`{ event, payload }`; the
/// core takes the replies): the listeners of `event`, in the order they
/// were added, each with `payload`. A listener that throws leaves the next
/// ones called; the first error is thrown once they all ran.
unsafe extern "C" fn on_host_event(
    ctx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let e = arg(argc, argv, 0);
    let string = |key: &std::ffi::CStr| {
        // SAFETY: a read of the handler's argument; the result is freed.
        unsafe {
            let v = qjs::JS_GetPropertyStr(ctx, e, key.as_ptr());
            let s = qjs::JS_IsString(v)
                .then(|| dom::string_arg(ctx, v))
                .flatten();
            qjs::JS_FreeValue(ctx, v);
            s
        }
    };
    if string(c"type").as_deref() != Some("event") {
        return UNDEFINED;
    }
    let event = string(c"event");
    // SAFETY: an owned result, freed below.
    let payload = unsafe { qjs::JS_GetPropertyStr(ctx, e, c"payload".as_ptr()) };
    let listeners: Vec<JsValue> = match &event {
        Some(event) => modules(ctx)
            .host_listeners
            .borrow()
            .iter()
            .filter(|(_, e, _)| e == event)
            // SAFETY: dups for the calls.
            .map(|&(_, _, f)| unsafe { qjs::JS_DupValue(ctx, f) })
            .collect(),
        None => Vec::new(),
    };
    let mut first = None;
    let mut fatal = false;
    for f in listeners {
        if !fatal {
            let mut args = [payload];
            // SAFETY: a call of an owned function with a borrowed argument,
            // then its result.
            unsafe {
                let r = qjs::JS_Call(ctx, f, UNDEFINED, 1, args.as_mut_ptr());
                if qjs::JS_IsException(r) {
                    let error = crate::web::js::take_exception(ctx);
                    // An interrupt stops them all.
                    if qjs::JS_IsUncatchableError(error.raw()) {
                        first = Some(error);
                        fatal = true;
                    } else {
                        first.get_or_insert(error);
                    }
                } else {
                    qjs::JS_FreeValue(ctx, r);
                }
            }
        }
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(ctx, f) };
    }
    // SAFETY: ours.
    unsafe { qjs::JS_FreeValue(ctx, payload) };
    match first {
        Some(error) => {
            let _ = crate::web::js::throw(ctx, error);
            qjs::JS_EXCEPTION
        }
        None => UNDEFINED,
    }
}

/// The hand-written exports of `nsh/host` (with the registry's).
pub(crate) const HOST_EXPORTS: &[Item] = &[(
    "host",
    Export::Value(host_module),
    Ts::value(
        "The app embedding NSH: `host.call(name, args)` calls one of its functions\n(granted by `capabilities.host` in nsh.json), `host.on(event, f)` hears its\nevents, `host.available()` says whether the platform embeds one.",
        "Host & hostModule & HostEvents",
    ),
)];

/// The hand-written exports of `nsh/mobile` (with the registry's
/// `TabBar`).
pub(crate) const MOBILE_EXPORTS: &[Item] = &[(
    "isAvailable",
    Export::Value(|cx| boolean(matches!(os(cx), Os::Ios | Os::Android))),
    Ts::value("True on iOS (and Mac Catalyst) and Android.", "boolean"),
)];

/// `nsh/ios`.
pub(crate) const IOS_EXPORTS: &[Item] = &[
    (
        "isAvailable",
        Export::Value(|cx| boolean(os(cx) == Os::Ios)),
        Ts::value("True on iOS (and Mac Catalyst).", "boolean"),
    ),
    (
        "InputAccessoryView",
        Export::Value(|cx| {
            if os(cx) == Os::Ios {
                dom::host_component(cx, "inputaccessory", true)
            } else {
                reactive::new_function(cx, c"InputAccessoryView", nothing, 1)
            }
        }),
        Ts::function(
            "A bar over the keyboard of the inputs whose `inputAccessoryViewID` is its\n`nativeID` (iOS's `inputAccessoryView`): as wide as the window and as tall\nas its content, moving with the keyboard natively. It renders nothing where\nit is placed in the tree, and nothing at all on Android.",
            &["(props: InputAccessoryViewProps): YNode | null"],
        ),
    ),
];

/// `nsh/ios`'s types.
pub(crate) const IOS_TYPES: &str = r#"export interface InputAccessoryViewProps {
  /** Inputs with this `inputAccessoryViewID` show the view over the keyboard. */
  nativeID: string;
  style?: StyleProp<ViewStyle>;
  class?: string;
  children?: JSX.Element;
}
"#;

/// `nsh/webview`.
pub(crate) const WEBVIEW_EXPORTS: &[Item] = &[(
    "WebView",
    Export::Value(|cx| dom::host_component(cx, "webview", false)),
    Ts::value(
        "A web page (WKWebView / android.webkit.WebView); its `ref` has\n`reload()`, `goBack()`, `goForward()`, `stopLoading()`,\n`injectJavaScript(script)` and `postMessage(data)`.",
        "(props: WebViewProps) => YNode",
    ),
)];

/// `nsh/webview`'s types.
pub(crate) const WEBVIEW_TYPES: &str = r#"export type { WebViewNavigation };

export interface WebViewProps extends Omit<ViewProps, "children" | "ios" | "desktop">, WebViewHostProps {
  ios?: IOSWebViewHostProps;
  desktop?: DesktopWebViewHostProps;
}
"#;

/// `nsh/video`.
pub(crate) const VIDEO_EXPORTS: &[Item] = &[(
    "Video",
    Export::Value(|cx| dom::host_component(cx, "video", false)),
    Ts::value(
        "A video player (AVPlayer / MediaPlayer); its `ref` has `seek(seconds)`.",
        "(props: VideoProps) => YNode",
    ),
)];

/// `nsh/video`'s types.
pub(crate) const VIDEO_TYPES: &str = r#"export interface VideoProps extends Omit<ViewProps, "children">, VideoHostProps {
  src: string;
}
"#;

// --- nsh/native ---------------------------------------------------------------------------

/// `nativeComponent(name, { props, events })`: the component of native
/// component `name` the embedding app registers: its own props go as
/// `$name`, its events to `on<Event>` handlers, the rest as on a view.
unsafe extern "C" fn native_component(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut data = [arg(argc, argv, 0), arg(argc, argv, 1)];
    native(cx, render_native, 1, &mut data)
}

/// The strings of array `spec[key]`.
fn names(cx: *mut JsContext, spec: JsValue, key: &CStr) -> Vec<String> {
    let mut out = Vec::new();
    // SAFETY: reads of live values; every value got is freed.
    unsafe {
        if !qjs::JS_IsObject(spec) {
            return out;
        }
        let list = qjs::JS_GetPropertyStr(cx, spec, key.as_ptr());
        let mut len: i64 = 0;
        if qjs::JS_IsArray(list) && qjs::JS_GetLength(cx, list, &mut len) == 0 {
            for i in 0..len.max(0) {
                let v = qjs::JS_GetPropertyInt64(cx, list, i);
                if let Some(s) = dom::string_arg(cx, v) {
                    out.push(s);
                }
                qjs::JS_FreeValue(cx, v);
            }
        }
        qjs::JS_FreeValue(cx, list);
    }
    out
}

fn handler_name(event: &str) -> String {
    let mut c = event.chars();
    match c.next() {
        Some(first) => format!("on{}{}", first.to_ascii_uppercase(), c.as_str()),
        None => "on".to_owned(),
    }
}

unsafe extern "C" fn render_native(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (name, spec).
    let (name, spec) = unsafe { (*data, *data.add(1)) };
    let props = arg(argc, argv, 0);
    let own = names(cx, spec, c"props");
    let events = names(cx, spec, c"events");
    let node = match dom::create_element(cx, Tag::Native) {
        Ok(node) => node,
        Err(e) => return e,
    };
    let result = (|| -> Result<(), JsValue> {
        dom::set_prop_value(cx, node, "component", name)?;
        let mut skip: Vec<String> = own.clone();
        skip.extend(events.iter().map(|e| handler_name(e)));
        skip.push("children".into());
        let skip_refs: Vec<&str> = skip.iter().map(String::as_str).collect();
        dom::spread_except(cx, node, props, &skip_refs)?;
        // Its own props, as the component's (`$name`), followed.
        for key in &own {
            let get = dom::prop_reader(cx, props, key);
            let wire = format!("${key}");
            let r = dom::bind_prop_with(cx, node, &wire, get);
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, get) };
            r?;
        }
        if !events.is_empty() {
            let on = native(cx, native_event, 1, &mut [props]);
            let r = dom::set_handler(
                cx,
                dom::node_id(cx, node).unwrap_or(0),
                EventKind::NativeEvent,
                on,
            );
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, on) };
            r?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => reactive::finish_value(cx, node),
        Err(e) => {
            // SAFETY: ours.
            unsafe { qjs::JS_FreeValue(cx, node) };
            e
        }
    }
}

/// A native component's event: to its `on<Event>` handler.
unsafe extern "C" fn native_event(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the props); values got are freed.
    unsafe {
        let props = *data;
        let e = arg(argc, argv, 0);
        let name = qjs::JS_GetPropertyStr(cx, e, c"name".as_ptr());
        let handler = dom::string_arg(cx, name).map(|n| {
            let k = CString::new(handler_name(&n)).unwrap_or_default();
            qjs::JS_GetPropertyStr(cx, props, k.as_ptr())
        });
        qjs::JS_FreeValue(cx, name);
        let Some(handler) = handler else {
            return qjs::JS_EXCEPTION;
        };
        if !qjs::JS_IsFunction(cx, handler) {
            qjs::JS_FreeValue(cx, handler);
            return UNDEFINED;
        }
        let mut args = [qjs::JS_GetPropertyStr(cx, e, c"data".as_ptr())];
        let r = qjs::JS_Call(cx, handler, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, args[0]);
        qjs::JS_FreeValue(cx, handler);
        r
    }
}

/// `nativeModule(specifier)`: the exports of the UI set the embedding app
/// registered under `specifier`, as one object, the same each call.
unsafe extern "C" fn native_module(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(specifier) = dom::string_arg(cx, arg(argc, argv, 0)) else {
        // SAFETY: throws on a live context.
        return unsafe { qjs::JS_ThrowTypeError(cx, c"nativeModule: a specifier string".as_ptr()) };
    };
    let Some(m) = crate::modules::host_module(cx, &specifier) else {
        let message = CString::new(format!(
            "nativeModule: nothing is registered under \"{specifier}\"; the embedding app \
             registers its functions as a UI set of that name (`Registry::ui_set(\"{specifier}\")` \
             in its engines' UI sets)"
        ))
        .unwrap_or_default();
        // SAFETY: throws on a live context; `%s` keeps the message literal.
        return unsafe { qjs::JS_ThrowReferenceError(cx, c"%s".as_ptr(), message.as_ptr()) };
    };

    m
}

/// `nsh/native`.
pub(crate) const NATIVE_EXPORTS: &[Item] = &[
    (
        "nativeComponent",
        Export::Function(native_component, 2),
        Ts::function(
            "A component for the native component the embedding app registered as\n`name` (Swift `NshAppView.register(component:)`, Java\n`NshView.registerComponent`). It is laid out like a view, at the size its\nstyle gives it, else at the size the component reports. Its `ref` calls\ncommands: `ref.command(\"zoomTo\", { level: 3 })`. Where nothing is\nregistered under `name`, it renders an empty view.",
            &[
                "<P extends object = {}, E extends object = {}>(name: string, spec: NativeComponentSpec<P, E>): (props: NativeComponentProps<P, E>) => YNode",
            ],
        ),
    ),
    (
        "nativeModule",
        Export::Function(native_module, 1),
        Ts::function(
            "The exports of the UI set the embedding app registered as `specifier`\n(`Registry::ui_set(\"host/trading\")` among its engines' UI sets: Rust\n`set_ui_sets`, `EngineConfig::ui_sets`): its modules, classes, functions\nand components, as one object, the same on every call. The app declares\nthe type `T` itself, so it builds with the stock `nsh build`:\n`nativeModule<{ Trading: TradingApi }>(\"host/trading\").Trading.quote(\"AAPL\")`.\nCalls work as through an import: plain functions return their value,\n`async` ones a promise, and callbacks can be called later by Rust. Where\nnothing is registered under `specifier`, it throws a `ReferenceError`\nnaming it.",
            &["<T extends object>(specifier: string): T"],
        ),
    ),
];

/// `nsh/native`'s types.
pub(crate) const NATIVE_TYPES: &str = r#"/** Handlers of a native component's events: `regionChange` -> `onRegionChange`. */
export type NativeEventHandlers<E> = { [K in keyof E & string as `on${Capitalize<K>}`]?: (data: E[K]) => void };

/** The props of a native component: a view's (style, classes, layout,
 * accessibility, `ref`), its own `P` and handlers of its events `E`. Each
 * number or string (color) prop may also be an animated value: the
 * platform then pushes its value (a number or a color) to the component
 * on every frame it changes, without JS. */
export type NativeComponentProps<P, E> = Omit<ViewProps, "children"> & { [K in keyof P]: NonNullable<P[K]> extends number | string ? P[K] | AnimatedNode : P[K] } & NativeEventHandlers<E>;

/** What a native component takes and emits. */
export interface NativeComponentSpec<P, E> {
  /** Its own props: sent to the component (any JSON value), each when it
   * changes; an animated value is pushed on every frame it changes. */
  props: readonly (keyof P & string)[];
  /** The events it emits. */
  events?: readonly (keyof E & string)[];
}
"#;
