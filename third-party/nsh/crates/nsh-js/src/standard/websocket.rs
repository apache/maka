//! Global WebSocket transport selection. The browser uses its host service;
//! native hosts retain the VM-owned tungstenite transport.
//!
//! As a browser's, the constructor throws only for a wrong use (a bad URL
//! or protocol: `SyntaxError`); a URL the app's network capabilities do
//! not grant opens no connection, and the socket fires `error` and then
//! `close` (code 1006, not clean), as a refused connection does; so does
//! one the host refuses (a test's network,
//! `nsh_core::element::System::refuse_connections`). A used-up
//! quota (32 WebSockets per VM, shared with the `websocket` module) throws
//! `ERR_NSH_QUOTA_EXCEEDED`, a platform without WebSockets
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
#[cfg(not(target_arch = "wasm32"))]
#[path = "websocket_native.rs"]
mod native;

use std::{
    cell::RefCell,
    collections::VecDeque,
    rc::Rc,
    task::{Poll, Waker},
};

use nsh_core::{
    element::{IntoThrown, JsError, codes},
    websocket::{WebSocketData, WebSocketEvent, WebSocketRequest, WebSocketTask},
};
use rquickjs::{Ctx, Exception, Function, Object, Result, Value, function::Func};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const QUEUE: usize = 32;

/// Throws `error` with its class and properties (`code`, ...).
fn throw(cx: &Ctx<'_>, error: JsError) -> rquickjs::Error {
    let raw = cx.as_raw().as_ptr();
    let value = crate::classes::error_value(raw, &error.into_thrown());
    let _ = crate::web::js::throw(raw, value);
    rquickjs::Error::Exception
}

/// The VM's place for one more WebSocket (shared with the `websocket`
/// module), or the thrown `ERR_NSH_QUOTA_EXCEEDED`.
fn slot(cx: &Ctx<'_>) -> Result<nsh_core::element::Held> {
    use nsh_core::runtime::{MAX_WEBSOCKETS, WEBSOCKETS};
    crate::dom::shared(cx.as_raw().as_ptr())
        .system_quotas
        .take(WEBSOCKETS, MAX_WEBSOCKETS)
        .ok_or_else(|| {
            throw(
                cx,
                JsError::Error(format!(
                    "At most {MAX_WEBSOCKETS} concurrent WebSockets are allowed per VM"
                ))
                .with_code(codes::QUOTA_EXCEEDED),
            )
        })
}

/// A quota of one socket is used up (its queue, its buffered bytes).
fn exceeded(cx: &Ctx<'_>, message: &str) -> rquickjs::Error {
    throw(
        cx,
        JsError::Error(message.to_owned()).with_code(codes::QUOTA_EXCEEDED),
    )
}

/// Why a WebSocket to `url` opens no connection: the app's capabilities do
/// not grant it.
fn denial(url: &url::Url) -> String {
    format!(
        "a WebSocket to `{url}` is not granted; add its host to capabilities.network.hosts or a GET rule in capabilities.network.http"
    )
}

/// Why the host refuses a WebSocket to `url` before it reaches the network
/// (a test's network: `nsh_core::element::System::refuse_connections`), if
/// it does.
fn host_refusal(cx: &Ctx<'_>, url: &url::Url) -> Option<String> {
    let refuse = crate::dom::shared(cx.as_raw().as_ptr())
        .system_refuse_connections
        .borrow()
        .clone()?;
    Some(refuse(url.as_str()).message().to_owned())
}

/// The transport of a WebSocket that opens no connection: as a browser's
/// refused connection, it fires `error` (with `message`) and then `close`
/// (1006, not clean) after the constructor returns, so the app's handlers
/// set in the same turn hear them.
fn refused<'js>(cx: Ctx<'js>, callback: Function<'js>, message: String) -> Result<Object<'js>> {
    let handle = Object::new(cx.clone())?;
    handle.set("bufferedAmount", Func::from(|| 0usize))?;
    handle.set("send", Func::from(|_: Value<'js>| -> Result<()> { Ok(()) }))?;
    handle.set(
        "close",
        Func::from(|_: u16, _: String| -> Result<()> { Ok(()) }),
    )?;
    let task_cx = cx.clone();
    cx.spawn(async move {
        let mut yielded = false;
        std::future::poll_fn(|cx| {
            if yielded {
                Poll::Ready(())
            } else {
                yielded = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        })
        .await;
        if deliver(&task_cx, &callback, WebSocketEvent::Error(message), &[]).is_ok() {
            let _ = deliver(
                &task_cx,
                &callback,
                WebSocketEvent::Close {
                    code: 1006,
                    reason: String::new(),
                    was_clean: false,
                },
                &[],
            );
        }
    });
    Ok(handle)
}

#[derive(Default)]
struct Events {
    pending: VecDeque<WebSocketEvent>,
    bytes: usize,
    overflow: bool,
    cancelled: bool,
    waker: Option<Waker>,
}
impl Events {
    fn wake(&mut self) {
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}

pub(crate) fn connect(
    cx: crate::web::js::Ctx,
    url: String,
    protocols: Vec<String>,
    callback: crate::web::js::V,
) -> crate::web::js::R<crate::web::js::V> {
    let transport = crate::dom::shared(cx).system_websocket.borrow().clone();
    let Some(transport) = transport else {
        #[cfg(not(target_arch = "wasm32"))]
        return native::connect(cx, url, protocols, callback);
        #[cfg(target_arch = "wasm32")]
        {
            let error = JsError::Error("The host has no WebSocket transport configured".into())
                .with_code(codes::UNAVAILABLE);
            let value = crate::classes::error_value(cx, &error.into_thrown());
            return Err(crate::web::js::throw(cx, value));
        }
    };
    // SAFETY: the caller lends a live context for this operation.
    let rq = unsafe { Ctx::from_raw(std::ptr::NonNull::new(cx).expect("a live context")) };
    // SAFETY: the owned value transfers exactly one reference.
    let callback = unsafe { Value::from_raw(rq.clone(), callback.take()) };
    let callback = callback
        .into_function()
        .ok_or_else(|| crate::web::js::type_error(cx, "WebSocket callback is not a function"))?;
    let result = open(rq, transport, url, protocols, callback);
    result
        .map(|handle| crate::web::js::V::dup(cx, handle.as_raw()))
        .map_err(|_| crate::web::js::Throw)
}

fn open<'js>(
    cx: Ctx<'js>,
    transport: std::sync::Arc<dyn nsh_core::websocket::WebSocketTransport>,
    url: String,
    protocols: Vec<String>,
    callback: Function<'js>,
) -> Result<Object<'js>> {
    let parsed =
        url::Url::parse(&url).map_err(|_| Exception::throw_syntax(&cx, "Invalid WebSocket URL"))?;
    if !matches!(parsed.scheme(), "ws" | "wss")
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(Exception::throw_syntax(
            &cx,
            "WebSocket requires a ws/wss URL without credentials or fragment",
        ));
    }
    let shared = crate::dom::shared(cx.as_raw().as_ptr());
    if !shared
        .system_access
        .borrow()
        .allows_websocket(parsed.as_str())
    {
        return refused(cx, callback, denial(&parsed));
    }
    if let Some(message) = host_refusal(&cx, &parsed) {
        return refused(cx, callback, message);
    }
    let slot = slot(&cx)?;
    let events = Rc::new(RefCell::new(Events::default()));
    let incoming = events.clone();
    let task = match transport.connect(
        WebSocketRequest {
            url: parsed.to_string(),
            protocols: protocols.clone(),
            headers: Vec::new(),
        },
        Box::new(move |event| {
            let mut queue = incoming.borrow_mut();
            if queue.cancelled || queue.overflow {
                return;
            }
            let size = match &event {
                WebSocketEvent::Message(WebSocketData::Text(text)) => text.len(),
                WebSocketEvent::Message(WebSocketData::Bytes(bytes)) => bytes.len(),
                _ => 0,
            };
            if queue.pending.len() >= QUEUE
                || size > MAX_MESSAGE
                || queue.bytes.saturating_add(size) > MAX_MESSAGE
            {
                queue.overflow = true;
            } else {
                queue.bytes += size;
                queue.pending.push_back(event);
            }
            queue.wake();
        }),
    ) {
        Ok(task) => task,
        // The host refused it: as a connection that failed.
        Err(error) => return refused(cx, callback, error),
    };
    let task: Rc<RefCell<Option<Box<dyn WebSocketTask>>>> = Rc::new(RefCell::new(Some(task)));
    let handle = Object::new(cx.clone())?;
    let read_task = Rc::downgrade(&task);
    handle.set(
        "bufferedAmount",
        Func::from(move || {
            read_task
                .upgrade()
                .and_then(|task| task.borrow().as_ref().map(|task| task.buffered_amount()))
                .unwrap_or(0)
        }),
    )?;
    let send_task = Rc::downgrade(&task);
    handle.set(
        "send",
        Func::from(move |cx: Ctx<'js>, data: Value<'js>| -> Result<()> {
            let data = if let Some(text) = data.as_string() {
                WebSocketData::Text(text.to_string()?)
            } else if let Some(blob) =
                crate::web::blob::blob_of(cx.as_raw().as_ptr(), data.as_raw())
                    .map_err(|_| rquickjs::Error::Exception)?
            {
                if blob.bytes().len() > MAX_MESSAGE {
                    return Err(Exception::throw_range(
                        &cx,
                        "WebSocket message exceeds 8 MiB",
                    ));
                }
                WebSocketData::Bytes(blob.bytes().to_vec())
            } else {
                // SAFETY: the value remains alive until its bytes have been copied.
                let bytes =
                    unsafe { crate::web::js::bytes_of(cx.as_raw().as_ptr(), data.as_raw()) }
                        .ok_or_else(|| {
                            Exception::throw_type(
                                &cx,
                                "send expects text, Blob, ArrayBuffer or a typed array",
                            )
                        })?;
                if bytes.len() > MAX_MESSAGE {
                    return Err(Exception::throw_range(
                        &cx,
                        "WebSocket message exceeds 8 MiB",
                    ));
                }
                WebSocketData::Bytes(bytes.to_vec())
            };
            let size = match &data {
                WebSocketData::Text(text) => text.len(),
                WebSocketData::Bytes(bytes) => bytes.len(),
            };
            if size > MAX_MESSAGE {
                return Err(Exception::throw_range(
                    &cx,
                    "WebSocket message exceeds 8 MiB",
                ));
            }
            // A socket that is closing discards what is sent, as a
            // browser's does: its `close` event follows.
            let Some(task) = send_task.upgrade() else {
                return Ok(());
            };
            let mut task = task.borrow_mut();
            let Some(task) = task.as_mut() else {
                return Ok(());
            };
            if task.buffered_amount().saturating_add(size) > MAX_MESSAGE {
                return Err(exceeded(&cx, "WebSocket buffered data exceeds 8 MiB"));
            }
            task.send(data)
                .map_err(|error| throw(&cx, JsError::Error(error)))
        }),
    )?;
    let close_task = Rc::downgrade(&task);
    handle.set(
        "close",
        Func::from(
            move |cx: Ctx<'js>, code: u16, reason: String| -> Result<()> {
                if let Some(task) = close_task.upgrade()
                    && let Some(task) = task.borrow_mut().as_mut()
                {
                    task.close(code, &reason)
                        .map_err(|error| throw(&cx, JsError::Error(error)))?;
                }
                Ok(())
            },
        ),
    )?;
    let cleanup_task = Rc::downgrade(&task);
    let cleanup_events = Rc::downgrade(&events);
    let cleanup = Function::new(cx.clone(), move || {
        if let Some(task) = cleanup_task.upgrade() {
            task.borrow_mut().take();
        }
        if let Some(events) = cleanup_events.upgrade() {
            let mut events = events.borrow_mut();
            events.cancelled = true;
            events.wake();
        }
    })?;
    let raw = cx.as_raw().as_ptr();
    let owned_cleanup = crate::web::js::V::dup(raw, cleanup.as_value().as_raw());
    if crate::reactive::has_owner(raw) {
        let mut callback = owned_cleanup.raw();
        // SAFETY: the live function is borrowed; on_cleanup retains its reference.
        let result = unsafe {
            crate::reactive::on_cleanup(raw, rquickjs::qjs::JS_UNDEFINED, 1, &mut callback)
        };
        drop(crate::web::js::V::own(raw, result));
    } else {
        crate::hot::undo_on_rerun(raw, owned_cleanup);
    }
    let task_cx = cx.clone();
    cx.spawn(async move {
        let _slot = slot;
        let _task = task;
        let mut delivered = 0;
        loop {
            if delivered == QUEUE {
                delivered = 0;
                let mut yielded = false;
                std::future::poll_fn(|cx| {
                    if yielded {
                        Poll::Ready(())
                    } else {
                        yielded = true;
                        cx.waker().wake_by_ref();
                        Poll::Pending
                    }
                })
                .await;
            }
            let event = std::future::poll_fn(|cx| {
                let mut events = events.borrow_mut();
                if events.cancelled {
                    return Poll::Ready(None);
                }
                if events.overflow {
                    return Poll::Ready(Some(WebSocketEvent::Error(
                        "WebSocket incoming queue exceeds its limit".into(),
                    )));
                }
                if let Some(event) = events.pending.pop_front() {
                    events.bytes = events.bytes.saturating_sub(match &event {
                        WebSocketEvent::Message(WebSocketData::Text(text)) => text.len(),
                        WebSocketEvent::Message(WebSocketData::Bytes(bytes)) => bytes.len(),
                        _ => 0,
                    });
                    return Poll::Ready(Some(event));
                }
                events.waker = Some(cx.waker().clone());
                Poll::Pending
            })
            .await;
            let Some(event) = event else {
                break;
            };
            delivered += 1;
            if let WebSocketEvent::Open { protocol } = &event
                && !protocol.is_empty()
                && !protocols.contains(protocol)
            {
                let _ = deliver(
                    &task_cx,
                    &callback,
                    WebSocketEvent::Error("Server selected an unrequested protocol".into()),
                    &protocols,
                );
                let _ = deliver(
                    &task_cx,
                    &callback,
                    WebSocketEvent::Close {
                        code: 1006,
                        reason: String::new(),
                        was_clean: false,
                    },
                    &protocols,
                );
                break;
            }
            let terminal = matches!(&event, WebSocketEvent::Close { .. });
            let overflow = events.borrow().overflow;
            if deliver(&task_cx, &callback, event, &protocols).is_err() {
                break;
            }
            if overflow {
                let _ = deliver(
                    &task_cx,
                    &callback,
                    WebSocketEvent::Close {
                        code: 1006,
                        reason: String::new(),
                        was_clean: false,
                    },
                    &protocols,
                );
                break;
            }
            if terminal {
                break;
            }
        }
    });
    Ok(handle)
}

fn deliver<'js>(
    cx: &Ctx<'js>,
    callback: &Function<'js>,
    event: WebSocketEvent,
    protocols: &[String],
) -> Result<()> {
    match event {
        WebSocketEvent::Open { protocol } => {
            if !protocol.is_empty() && !protocols.contains(&protocol) {
                return Err(Exception::throw_type(
                    cx,
                    "Server selected an unrequested protocol",
                ));
            }
            let data = Object::new(cx.clone())?;
            data.set("protocol", protocol)?;
            callback.call(("open", data))
        }
        WebSocketEvent::Message(WebSocketData::Text(text)) => callback.call(("message", text)),
        WebSocketEvent::Message(WebSocketData::Bytes(bytes)) => callback.call((
            "message",
            rquickjs::ArrayBuffer::new_copy(cx.clone(), &bytes)?,
        )),
        WebSocketEvent::Error(error) => callback.call(("error", error)),
        WebSocketEvent::Close {
            code,
            reason,
            was_clean,
        } => {
            let data = Object::new(cx.clone())?;
            data.set("code", code)?;
            data.set("reason", reason)?;
            data.set("wasClean", was_clean)?;
            callback.call(("close", data))
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use nsh_core::{
        access::{Access, Capabilities},
        websocket::{WebSocketEvents, WebSocketTransport},
    };

    use super::*;
    thread_local! {
        static CALLBACK: RefCell<Option<WebSocketEvents>> = RefCell::new(None);
        static SENT: RefCell<Vec<WebSocketData>> = const { RefCell::new(Vec::new()) };
        static DROPPED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    struct Transport;
    struct Task;
    impl WebSocketTransport for Transport {
        fn connect(
            &self,
            request: WebSocketRequest,
            events: WebSocketEvents,
        ) -> std::result::Result<Box<dyn WebSocketTask>, String> {
            assert_eq!(request.url, "ws://127.0.0.1/");
            assert_eq!(request.protocols, ["chat"]);
            CALLBACK.with(|callback| *callback.borrow_mut() = Some(events));
            DROPPED.set(false);
            Ok(Box::new(Task))
        }
    }
    impl WebSocketTask for Task {
        fn send(&mut self, data: WebSocketData) -> std::result::Result<(), String> {
            SENT.with(|sent| sent.borrow_mut().push(data));
            Ok(())
        }
        fn close(&mut self, _: u16, _: &str) -> std::result::Result<(), String> {
            Ok(())
        }
        fn buffered_amount(&self) -> usize {
            0
        }
        fn pause(&mut self, _: bool) {}
    }
    impl Drop for Task {
        fn drop(&mut self) {
            DROPPED.set(true);
            CALLBACK.with(|callback| callback.borrow_mut().take());
        }
    }
    fn event(event: WebSocketEvent) {
        CALLBACK.with(|callback| callback.borrow_mut().as_mut().unwrap()(event));
    }
    fn host() -> crate::Host {
        let host = crate::Host::new().unwrap();
        host.set_websocket_transport(Some(std::sync::Arc::new(Transport)));
        host.set_system_access(
            Access {
                declared: Capabilities::from_json(
                    &serde_json::json!({"network":{"hosts":["127.0.0.1"]}}),
                )
                .unwrap(),
                granted: None,
            },
            None,
        );
        host
    }
    #[test]
    fn service_transport_keeps_native_global_event_and_binary_semantics() {
        let host = host();
        host.eval_source(r#"
            globalThis.received = [];
            globalThis.socket = new WebSocket('ws://127.0.0.1/', ['chat']);
            socket.binaryType = 'arraybuffer';
            socket.onopen = () => { if (!(socket instanceof EventTarget) || socket.protocol !== 'chat') throw Error('identity'); socket.send('hello'); socket.send(new Uint8Array([1,2])); };
            socket.onmessage = e => received.push(typeof e.data === 'string' ? e.data : Array.from(new Uint8Array(e.data)).join(','));
            socket.onclose = e => received.push([e.code,e.reason,e.wasClean,socket.readyState]);
        "#).unwrap();
        event(WebSocketEvent::Open {
            protocol: "chat".into(),
        });
        host.run_jobs();
        SENT.with(|sent| {
            assert_eq!(
                sent.borrow_mut().drain(..).collect::<Vec<_>>(),
                [
                    WebSocketData::Text("hello".into()),
                    WebSocketData::Bytes(vec![1, 2])
                ]
            )
        });
        event(WebSocketEvent::Message(WebSocketData::Text("echo".into())));
        event(WebSocketEvent::Message(WebSocketData::Bytes(vec![3, 4])));
        event(WebSocketEvent::Close {
            code: 1000,
            reason: "done".into(),
            was_clean: true,
        });
        host.run_jobs();
        host.eval_source(r#"if (JSON.stringify(received) !== '["echo","3,4",[1000,"done",true,3]]') throw Error(JSON.stringify(received));"#).unwrap();
        assert!(DROPPED.get());
    }
    #[test]
    fn service_transport_bounds_incoming_queue_and_reports_abnormal_close() {
        let host = host();
        host.eval_source(r#"globalThis.errors=[];globalThis.socket=new WebSocket('ws://127.0.0.1/',['chat']);socket.onerror=e=>errors.push(e.message);socket.onclose=e=>errors.push(e.code);"#).unwrap();
        for _ in 0..=QUEUE {
            event(WebSocketEvent::Message(WebSocketData::Text("x".into())));
        }
        host.run_jobs();
        host.eval_source("if(errors.length!==2 || !errors[0].includes('queue exceeds') || errors[1]!==1006) throw Error(JSON.stringify(errors));").unwrap();
        assert!(DROPPED.get());
    }
    #[test]
    fn service_transport_owner_disposal_releases_host_socket_and_quota() {
        let host = host();
        host.with_raw(|raw| {
            // SAFETY: Host lends the live context to this closure.
            let cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new_unchecked(raw)) };
            crate::reactive::install_globals(&cx);
        });
        host.eval_source("__nsh_reactive.createRoot(dispose => {globalThis.disposeSocket = dispose; globalThis.socket = new WebSocket('ws://127.0.0.1/', ['chat']);});").unwrap();
        assert!(!DROPPED.get());
        host.eval_source("disposeSocket();").unwrap();
        host.run_jobs();
        assert!(DROPPED.get());
        host.with_raw(|raw| {
            assert!(
                crate::dom::shared(raw)
                    .system_quotas
                    .take(nsh_core::runtime::WEBSOCKETS, 1)
                    .is_some()
            )
        });
    }
    #[test]
    fn service_transport_denies_capabilities_before_host_connect() {
        let host = host();
        // No throw: the handlers set after the constructor hear `error` and
        // `close` (evaluating runs the turn's jobs, which deliver them).
        host.eval_source("globalThis.events=[];const s=new WebSocket('ws://example.org/');globalThis.before=[events.length,s.readyState];s.onerror=e=>events.push(e.type);s.onclose=e=>events.push(e.code,e.wasClean,s.readyState);").unwrap();
        host.run_jobs();
        host.eval_source("const seen=JSON.stringify([before,events]);if(seen!=='[[0,0],[\"error\",1006,false,3]]')throw Error(seen);").unwrap();
        CALLBACK.with(|callback| assert!(callback.borrow().is_none()));
    }
}
