//! The global `WebSocket`: a capability-checked transport on the owning VM.
//! (The `websocket` module's `WebSocket.connect` is the runtime's Rust
//! registry, `nsh_core::runtime`; both count under one per-VM cap.)
//!
//! The class itself is native, an `EventTarget` (`web/websocket.rs`).
//! Transport futures are owned by QuickJS and disappear with the VM.
use std::{cell::Cell, rc::Rc};

use futures_util::{SinkExt, StreamExt};
use rquickjs::{Ctx, Exception, Function, Object, Result, Value, function::Func};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    Message,
    client::IntoClientRequest,
    protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
/// Messages one socket delivers before it lets the engine's turn end.
const MESSAGES_PER_TURN: usize = 32;

/// Pending once, waking itself: QuickJS' scheduler then ends the turn
/// (`run_jobs` returns) and the engine's waker starts the next.
struct YieldNow(bool);

impl std::future::Future for YieldNow {
    type Output = ();

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        if self.0 {
            return std::task::Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    }
}
const QUEUE: usize = 8;
/// A place among the VM's WebSockets (shared with the `websocket` module),
/// or the `RangeError` saying there is none.
fn acquire_slot(cx: &Ctx<'_>) -> Result<nsh_core::element::Held> {
    use nsh_core::runtime::{MAX_WEBSOCKETS, WEBSOCKETS};
    crate::dom::shared(cx.as_raw().as_ptr())
        .system_quotas
        .take(WEBSOCKETS, MAX_WEBSOCKETS)
        .ok_or_else(|| {
            Exception::throw_range(
                cx,
                &format!("At most {MAX_WEBSOCKETS} concurrent WebSockets are allowed per VM"),
            )
        })
}

/// Whether the app may open a WebSocket to `url`, checked before any DNS
/// lookup: the handshake is a GET of the same URL over HTTP.
fn allowed(cx: &Ctx<'_>, url: &url::Url) -> bool {
    crate::dom::shared(cx.as_raw().as_ptr())
        .system_access
        .borrow()
        .allows_websocket(url.as_str())
}

enum Command {
    Send(Message),
    Close(Option<CloseFrame>),
}

/// Opens the transport of the global `WebSocket` (`web/websocket.rs`):
/// `callback(kind, data)` hears `open` (`{ protocol }`), `message`,
/// `error` (its message) and `close` (`{ code, reason, wasClean }`). The
/// URL is checked here, against the app's capabilities. Its `send`,
/// `close` and `bufferedAmount` object, or the pending exception.
pub(crate) fn connect(
    cx: crate::web::js::Ctx,
    url: String,
    protocols: Vec<String>,
    callback: crate::web::js::V,
) -> crate::web::js::R<crate::web::js::V> {
    // SAFETY: a live context, borrowed for this call.
    let rq = unsafe { Ctx::from_raw(std::ptr::NonNull::new(cx).expect("a live context")) };
    // SAFETY: the value takes the callback's reference.
    let callback = unsafe { Value::from_raw(rq.clone(), callback.take()) };
    let callback = callback
        .into_function()
        .ok_or(crate::web::js::Throw)
        .inspect_err(|_| {
            crate::web::js::type_error(cx, "WebSocket callback is not a function");
        })?;
    // Its transports do I/O on the VM's tokio runtime.
    if let Some(scheduler) = crate::dom::shared(cx).scheduler.upgrade() {
        scheduler.start_io().map_err(|e| {
            crate::web::js::type_error(cx, &format!("cannot start WebSocket I/O: {e}"))
        })?;
    }
    match open(rq, url, protocols, callback) {
        Ok(handle) => Ok(crate::web::js::V::dup(cx, handle.as_raw())),
        Err(_) => Err(crate::web::js::Throw),
    }
}

fn emit<'js>(callback: &Function<'js>, kind: &str, data: Value<'js>) -> Result<()> {
    callback.call((kind, data))
}

fn open<'js>(
    cx: Ctx<'js>,
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
    // The handshake API does not follow redirects. The URL checked is the
    // one connected to: the parsed, normalized form.
    if !allowed(&cx, &parsed) {
        return Err(Exception::throw_type(
            &cx,
            "WebSocket network capability denied",
        ));
    }
    let slot = acquire_slot(&cx)?;
    let mut request = parsed
        .as_str()
        .into_client_request()
        .map_err(|_| Exception::throw_syntax(&cx, "Invalid WebSocket URL"))?;
    if !protocols.is_empty() {
        let value = protocols
            .join(", ")
            .parse()
            .map_err(|_| Exception::throw_syntax(&cx, "Invalid WebSocket protocols"))?;
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", value);
    }
    let (tx, mut rx) = mpsc::channel(QUEUE);
    let buffered = Rc::new(Cell::new(0usize));
    let handle = Object::new(cx.clone())?;
    let send_tx = tx.clone();
    let send_buffered = buffered.clone();
    let read_buffered = buffered.clone();
    handle.set("bufferedAmount", Func::from(move || read_buffered.get()))?;
    handle.set(
        "send",
        Func::from(move |send_cx: Ctx<'js>, data: Value<'js>| -> Result<()> {
            let message = if let Some(s) = data.as_string() {
                let text = s.to_string()?;
                if text.len() > MAX_MESSAGE {
                    return Err(Exception::throw_range(
                        &send_cx,
                        "WebSocket message exceeds 8 MiB",
                    ));
                }
                Message::Text(text.into())
            } else if let Some(blob) =
                crate::web::blob::blob_of(send_cx.as_raw().as_ptr(), data.as_raw())
                    .map_err(|_| rquickjs::Error::Exception)?
            {
                if blob.bytes().len() > MAX_MESSAGE {
                    return Err(Exception::throw_range(
                        &send_cx,
                        "WebSocket message exceeds 8 MiB",
                    ));
                }
                Message::Binary(blob.bytes().to_vec().into())
            } else {
                // SAFETY: the bytes are copied while the JS value is alive.
                let bytes =
                    unsafe { crate::web::js::bytes_of(send_cx.as_raw().as_ptr(), data.as_raw()) }
                        .ok_or_else(|| {
                        Exception::throw_type(
                            &send_cx,
                            "send expects text, Blob, ArrayBuffer or a typed array",
                        )
                    })?;
                if bytes.len() > MAX_MESSAGE {
                    return Err(Exception::throw_range(
                        &send_cx,
                        "WebSocket message exceeds 8 MiB",
                    ));
                }
                Message::Binary(bytes.to_vec().into())
            };
            let length = message.len();
            if send_buffered.get().saturating_add(length) > MAX_MESSAGE {
                return Err(Exception::throw_range(
                    &send_cx,
                    "WebSocket buffered data exceeds 8 MiB",
                ));
            }
            send_tx.try_send(Command::Send(message)).map_err(|_| {
                Exception::throw_type(&send_cx, "WebSocket outbound queue is full or closed")
            })?;
            send_buffered.set(send_buffered.get() + length);
            Ok(())
        }),
    )?;
    handle.set(
        "close",
        Func::from(
            move |close_cx: Ctx<'js>, code: u16, reason: String| -> Result<()> {
                tx.try_send(Command::Close(Some(CloseFrame {
                    code: CloseCode::from(code),
                    reason: reason.into(),
                })))
                .map_err(|_| {
                    Exception::throw_type(&close_cx, "WebSocket outbound queue is full or closed")
                })
            },
        ),
    )?;
    // The same ownership rule as keymap bindings: component disposal or a
    // top-level module rerun aborts the transport, independent of queue capacity.
    let (abort_tx, abort_rx) = tokio::sync::oneshot::channel::<()>();
    let abort = Rc::new(std::cell::RefCell::new(Some(abort_tx)));
    let cleanup_abort = abort.clone();
    let cleanup = Function::new(cx.clone(), move || {
        if let Some(sender) = cleanup_abort.borrow_mut().take() {
            let _ = sender.send(());
        }
    })?;
    let raw = cx.as_raw().as_ptr();
    let owned_cleanup = crate::web::js::V::dup(raw, cleanup.as_value().as_raw());
    if crate::reactive::has_owner(raw) {
        let mut callback = owned_cleanup.raw();
        // SAFETY: one borrowed function; on_cleanup retains its own reference.
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
        let _abort_lifetime = abort;
        let operation = async {
            let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
            let handshake = tokio::time::timeout(std::time::Duration::from_secs(30), tokio_tungstenite::connect_async_with_config(request, Some(config), false));
            let (mut socket, response) = tokio::select! {
                result = handshake => result.map_err(|_| "WebSocket handshake timed out".to_string())?.map_err(|e| e.to_string())?,
                command = rx.recv() => {
                    if let Some(Command::Close(_)) = command {
                        return Err("WebSocket closed while connecting".into());
                    }
                    return Ok(());
                }
            };
            let protocol = response.headers().get("Sec-WebSocket-Protocol").and_then(|h| h.to_str().ok()).unwrap_or("");
            if !protocol.is_empty() && !protocols.iter().any(|p| p == protocol) { return Err("Server selected an unrequested protocol".into()); }
            let opened = Object::new(task_cx.clone()).map_err(|e| e.to_string())?;
            opened.set("protocol", protocol).map_err(|e| e.to_string())?;
            emit(&callback, "open", opened.into_value()).map_err(|e| e.to_string())?;
            let mut delivered = 0;
            loop {
                // A peer that floods frames keeps the socket ready: after a
                // turn's share the engine runs before more are delivered.
                if delivered >= MESSAGES_PER_TURN {
                    delivered = 0;
                    YieldNow(false).await;
                }
                tokio::select! {
                    command = rx.recv() => match command {
                        Some(Command::Send(message)) => {
                            let length = message.len();
                            tokio::time::timeout(std::time::Duration::from_secs(30), socket.send(message)).await.map_err(|_| "WebSocket write timed out".to_string())?.map_err(|e| e.to_string())?;
                            buffered.set(buffered.get().saturating_sub(length));
                        },
                        Some(Command::Close(frame)) => {
                            tokio::time::timeout(std::time::Duration::from_secs(5), socket.close(frame)).await.map_err(|_| "WebSocket close timed out".to_string())?.map_err(|e| e.to_string())?;
                            // Finish the close handshake, with a bounded wait.
                            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                                while let Some(next) = socket.next().await {
                                    if let Message::Close(frame) = next.map_err(|e| e.to_string())? { return Ok(frame); }
                                }
                                Err::<Option<CloseFrame>, String>("Peer disconnected before completing the WebSocket close handshake".into())
                            }).await.map_err(|_| "WebSocket close timed out".to_string())??;
                            closed(&task_cx, &callback, frame, true).map_err(|e| e.to_string())?;
                            return Ok(());
                        },
                        None => return Ok(()),
                    },
                    incoming = socket.next() => match incoming {
                        Some(Ok(Message::Text(text))) => { delivered += 1; emit(&callback, "message", rquickjs::String::from_str(task_cx.clone(), text.as_str()).map_err(|e| e.to_string())?.into_value()).map_err(|e| e.to_string())?; },
                        Some(Ok(Message::Binary(bytes))) => { delivered += 1; let buffer = rquickjs::ArrayBuffer::new_copy(task_cx.clone(), &bytes).map_err(|e| e.to_string())?; emit(&callback, "message", buffer.into_value()).map_err(|e| e.to_string())?; },
                        Some(Ok(Message::Close(frame))) => { let _ = socket.flush().await; closed(&task_cx, &callback, frame, true).map_err(|e| e.to_string())?; return Ok(()); },
                        Some(Ok(Message::Ping(_))) => { socket.flush().await.map_err(|e| e.to_string())?; },
                        Some(Ok(_)) => {},
                        Some(Err(e)) => return Err(e.to_string()),
                        None => return Err("WebSocket connection ended without a close frame".into()),
                    }
                }
            }
        };
        let outcome: std::result::Result<(), String> = tokio::select! {
            biased;
            _ = abort_rx => return,
            result = operation => result,
        };
        if let Err(error) = outcome {
            if let Ok(message) = rquickjs::String::from_str(task_cx.clone(), &error) { let _ = emit(&callback, "error", message.into_value()); }
            let _ = closed(&task_cx, &callback, None, false);
        }
    });
    Ok(handle)
}

fn closed<'js>(
    cx: &Ctx<'js>,
    callback: &Function<'js>,
    frame: Option<CloseFrame>,
    clean: bool,
) -> Result<()> {
    let data = Object::new(cx.clone())?;
    data.set(
        "code",
        frame
            .as_ref()
            .map(|f| u16::from(f.code))
            .unwrap_or(if clean { 1005 } else { 1006 }),
    )?;
    data.set(
        "reason",
        frame.as_ref().map(|f| f.reason.as_str()).unwrap_or(""),
    )?;
    data.set("wasClean", clean)?;
    emit(callback, "close", data.into_value())
}

#[cfg(test)]
#[path = "websocket_fixture.rs"]
mod tests;
