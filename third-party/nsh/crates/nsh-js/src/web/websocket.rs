//! The global `WebSocket` (WHATWG WebSockets): an `EventTarget` whose
//! transport is `standard/websocket.rs`'s capability-checked connection.
//! The transport hands every event to [`deliver`], which keeps the ready
//! state and dispatches it as the browser's event.

use std::ffi::c_int;

use rquickjs::qjs;

use super::{
    Class, Object, Spec, data,
    event::{self, Target},
    instance,
    js::{self, Ctx, R, Raw, V, native, trace},
};

const CONNECTING: u8 = 0;
const OPEN: u8 = 1;
const CLOSING: u8 = 2;
const CLOSED: u8 = 3;

/// A WebSocket.
struct Socket {
    target: Target,
    state: u8,
    url: String,
    protocol: String,
    /// `binaryType` is `"arraybuffer"` (else `"blob"`).
    array_buffers: bool,
    /// The transport's `send` / `close` / `bufferedAmount` object.
    handle: V,
}

trace!(Socket { target, handle });

impl Object for Socket {
    fn target(&mut self) -> Option<&mut Target> {
        Some(&mut self.target)
    }
}

fn socket<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, Socket>> {
    data::<Socket>(cx, v, "WebSocket")
}

/// Whether `protocol` is an HTTP token (RFC 9110), as a subprotocol is.
fn is_token(protocol: &str) -> bool {
    !protocol.is_empty()
        && protocol
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// The constructor's `protocols`: a string, a sequence of them, or none.
fn protocols(cx: Ctx, v: Raw) -> R<Vec<String>> {
    let list = if js::is_undefined(v) {
        Vec::new()
    } else if js::is_object(v) {
        let mut list = Vec::new();
        js::for_each(cx, v, |p| {
            list.push(js::to_string(cx, p.raw())?);
            Ok(())
        })?;
        list
    } else {
        vec![js::to_string(cx, v)?]
    };
    for (i, p) in list.iter().enumerate() {
        if !is_token(p) || list[..i].contains(p) {
            return Err(js::syntax_error(
                cx,
                "Invalid or duplicate WebSocket protocol",
            ));
        }
    }
    Ok(list)
}

native!(
    fn websocket_constructor(cx, this, args) {
        let url = js::to_string(cx, args.get(0))?;
        let url = ::url::Url::parse(&url)
            .map_err(|_| js::syntax_error(cx, "Invalid WebSocket URL"))?
            .to_string();
        let protocols = protocols(cx, args.get(1))?;
        let obj = instance(
            cx,
            this,
            Class::WebSocket,
            Socket {
                target: Target::default(),
                state: CONNECTING,
                url: url.clone(),
                protocol: String::new(),
                array_buffers: false,
                handle: V::undefined(),
            },
        )?;
        let callback = js::closure(cx, vec![obj.clone_ref()], |cx, captures, args| {
            let kind = js::to_string(cx, args.get(0))?;
            deliver(cx, captures[0].raw(), &kind, args.get(1))?;
            Ok(V::undefined())
        })?;
        let handle = crate::standard::websocket::connect(cx, url, protocols, callback)?;
        socket(cx, obj.raw())?.handle = handle;
        Ok(obj)
    }
);

/// Defines `key` on event `e` as the browser's events have it: read-only.
fn define_readonly(cx: Ctx, e: Raw, key: &std::ffi::CStr, value: V) -> R<()> {
    // SAFETY: the property takes the value.
    let r = unsafe { qjs::JS_DefinePropertyValueStr(cx, e, key.as_ptr(), value.take(), 0) };
    if r < 0 { Err(js::Throw) } else { Ok(()) }
}

/// The transport's event `kind` with its `data`, dispatched at `obj`.
fn deliver(cx: Ctx, obj: Raw, kind: &str, data: Raw) -> R<()> {
    let protocol = if kind == "open" {
        let protocol = js::get(cx, data, "protocol")?;
        js::to_string(cx, protocol.raw())?
    } else {
        String::new()
    };
    let array_buffers = {
        let mut s = socket(cx, obj)?;
        match kind {
            "open" if s.state == CLOSING => {
                // Closed while connecting: the connection ends unopened.
                let handle = s.handle.clone_ref();
                drop(s);
                let (code, reason) = (V::num(1000.0), js::string(cx, "")?);
                js::invoke(cx, handle.raw(), "close", &[code.raw(), reason.raw()])?;
                return Ok(());
            }
            "open" => {
                s.state = OPEN;
                s.protocol = protocol;
            }
            "close" => s.state = CLOSED,
            _ => {}
        }
        s.array_buffers
    };
    let e = event::trusted(cx, kind)?;
    match kind {
        "message" => {
            let value = match js::buffer_source(cx, data) {
                Some(bytes) if !array_buffers => {
                    super::blob::new_blob(cx, super::blob::Blob::new(bytes, String::new()))?
                }
                _ => V::dup(cx, data),
            };
            define_readonly(cx, e.raw(), c"data", value)?;
        }
        "close" => {
            for key in [c"code", c"reason", c"wasClean"] {
                let value = js::get(cx, data, &key.to_string_lossy())?;
                define_readonly(cx, e.raw(), key, value)?;
            }
        }
        "error" => define_readonly(cx, e.raw(), c"message", V::dup(cx, data))?,
        _ => {}
    }
    event::dispatch(cx, obj, e.raw())?;
    Ok(())
}

native!(
    fn websocket_send(cx, this, args) {
        let (state, handle) = {
            let s = socket(cx, this)?;
            (s.state, s.handle.clone_ref())
        };
        if state == CONNECTING {
            return Err(js::throw_dom(
                cx,
                "WebSocket is connecting",
                "InvalidStateError",
            ));
        }
        if state == OPEN {
            js::invoke(cx, handle.raw(), "send", &[args.get(0)])?;
        }
        Ok(V::undefined())
    }
);

native!(
    fn websocket_close(cx, this, args) {
        let code = if js::is_undefined(args.get(0)) {
            1000.0
        } else {
            js::to_number(cx, args.get(0))?
        };
        if code.fract() != 0.0 || (code != 1000.0 && !(3000.0..=4999.0).contains(&code)) {
            return Err(js::throw_dom(
                cx,
                "Invalid close code",
                "InvalidAccessError",
            ));
        }
        let reason = if js::is_undefined(args.get(1)) {
            String::new()
        } else {
            js::to_string(cx, args.get(1))?
        };
        if reason.len() > 123 {
            return Err(js::syntax_error(cx, "Close reason exceeds 123 bytes"));
        }
        let handle = {
            let mut s = socket(cx, this)?;
            if s.state >= CLOSING {
                return Ok(V::undefined());
            }
            s.state = CLOSING;
            s.handle.clone_ref()
        };
        let (code, reason) = (V::num(code), js::string(cx, &reason)?);
        js::invoke(cx, handle.raw(), "close", &[code.raw(), reason.raw()])?;
        Ok(V::undefined())
    }
);

native!(
    fn websocket_url(cx, this, args) {
        let url = socket(cx, this)?.url.clone();
        js::string(cx, &url)
    }
);

native!(
    fn websocket_ready_state(cx, this, args) {
        Ok(V::num(f64::from(socket(cx, this)?.state)))
    }
);

native!(
    fn websocket_protocol(cx, this, args) {
        let protocol = socket(cx, this)?.protocol.clone();
        js::string(cx, &protocol)
    }
);

native!(
    fn websocket_extensions(cx, this, args) {
        socket(cx, this)?;
        js::string(cx, "")
    }
);

native!(
    fn websocket_buffered_amount(cx, this, args) {
        let handle = socket(cx, this)?.handle.clone_ref();
        js::invoke(cx, handle.raw(), "bufferedAmount", &[])
    }
);

native!(
    fn websocket_binary_type(cx, this, args) {
        let array_buffers = socket(cx, this)?.array_buffers;
        js::string(cx, if array_buffers { "arraybuffer" } else { "blob" })
    }
);

native!(
    fn websocket_set_binary_type(cx, this, args) {
        let value = js::to_string(cx, args.get(0))?;
        if value == "blob" || value == "arraybuffer" {
            socket(cx, this)?.array_buffers = value == "arraybuffer";
        }
        Ok(V::undefined())
    }
);

/// The getter and setter of event handler attribute `on<kind>`.
macro_rules! handler {
    ($get:ident, $set:ident, $kind:literal) => {
        native!(
            fn $get(cx, this, args) {
                Ok(socket(cx, this)?.target.handler(cx, $kind))
            }
        );
        native!(
            fn $set(cx, this, args) {
                socket(cx, this)?
                    .target
                    .set_handler(cx, $kind, args.get(0));
                Ok(V::undefined())
            }
        );
    };
}

handler!(websocket_onopen, websocket_set_onopen, "open");
handler!(websocket_onmessage, websocket_set_onmessage, "message");
handler!(websocket_onerror, websocket_set_onerror, "error");
handler!(websocket_onclose, websocket_set_onclose, "close");

const LENGTH: c_int = 1;

pub(crate) const SPECS: &[Spec] = &[Spec {
    class: Class::WebSocket,
    name: c"WebSocket",
    parent: Some(Class::EventTarget),
    constructor: Some((websocket_constructor, LENGTH)),
    methods: &[
        (super::Key::Name(c"send"), websocket_send, 1),
        (super::Key::Name(c"close"), websocket_close, 0),
    ],
    accessors: &[
        (c"url", websocket_url, None),
        (c"readyState", websocket_ready_state, None),
        (c"protocol", websocket_protocol, None),
        (c"extensions", websocket_extensions, None),
        (c"bufferedAmount", websocket_buffered_amount, None),
        (
            c"binaryType",
            websocket_binary_type,
            Some(websocket_set_binary_type),
        ),
        (c"onopen", websocket_onopen, Some(websocket_set_onopen)),
        (
            c"onmessage",
            websocket_onmessage,
            Some(websocket_set_onmessage),
        ),
        (c"onerror", websocket_onerror, Some(websocket_set_onerror)),
        (c"onclose", websocket_onclose, Some(websocket_set_onclose)),
    ],
    statics: &[],
    constants: &[
        (c"CONNECTING", CONNECTING as f64),
        (c"OPEN", OPEN as f64),
        (c"CLOSING", CLOSING as f64),
        (c"CLOSED", CLOSED as f64),
    ],
    global: true,
    ts: super::ClassTs {
        doc: "A WebSocket connection, checked against the app's network capabilities.",
        head: " extends EventTarget",
        members: r#"constructor(url: string | URL, protocols?: string | string[]);
readonly url: string;
readonly readyState: number;
readonly protocol: string;
readonly extensions: string;
readonly bufferedAmount: number;
binaryType: "blob" | "arraybuffer";
onopen: ((event: Event) => void) | null;
onmessage: ((event: WebSocketMessageEvent) => void) | null;
onerror: ((event: WebSocketErrorEvent) => void) | null;
onclose: ((event: WebSocketCloseEvent) => void) | null;
send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
close(code?: number, reason?: string): void;"#,
    }
    .declared(),
}];

/// The TypeScript types of the WebSocket's events (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"interface WebSocketMessageEvent extends Event { readonly data: string | Blob | ArrayBuffer; }
interface WebSocketCloseEvent extends Event { readonly code: number; readonly reason: string; readonly wasClean: boolean; }
interface WebSocketErrorEvent extends Event { readonly message: string; }
"#;
