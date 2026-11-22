//! Browser WebSockets, owned by the same player and wasm instance as the engine.
//! While the `websocket` module's unread queue is full, the page holds the
//! socket's events (`websocket_pause` in `web/nsh.js`) and delivers them in
//! order once the app reads.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
};

use nsh_core::websocket::{
    WebSocketData, WebSocketEvent, WebSocketEvents, WebSocketRequest, WebSocketTask,
    WebSocketTransport,
};

use crate::ffi;

thread_local! {
    static SOCKETS: RefCell<HashMap<u32, WebSocketEvents>> = RefCell::new(HashMap::new());
    static LIVE: RefCell<HashSet<u32>> = RefCell::new(HashSet::new());
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
    static REPLY: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Uses the browser's WebSocket implementation.
pub(crate) struct BrowserWebSocket;

impl WebSocketTransport for BrowserWebSocket {
    fn supports_headers(&self) -> bool {
        false
    }

    fn connect(
        &self,
        request: WebSocketRequest,
        events: WebSocketEvents,
    ) -> Result<Box<dyn WebSocketTask>, String> {
        if !request.headers.is_empty() {
            return Err("Browser WebSockets do not support custom handshake headers".into());
        }
        let id = NEXT_ID.with(|n| n.replace(n.get().wrapping_add(1).max(1)));
        let request =
            serde_json::json!({ "url": request.url, "protocols": request.protocols }).to_string();
        LIVE.with(|s| s.borrow_mut().insert(id));
        SOCKETS.with(|s| s.borrow_mut().insert(id, events));
        if let Err(error) = result(ffi::websocket_start(id, &request)) {
            LIVE.with(|s| s.borrow_mut().remove(&id));
            SOCKETS.with(|s| s.borrow_mut().remove(&id));
            return Err(error);
        }
        Ok(Box::new(Socket { id }))
    }
}

struct Socket {
    id: u32,
}
impl WebSocketTask for Socket {
    fn send(&mut self, data: WebSocketData) -> Result<(), String> {
        let (bytes, binary) = match &data {
            WebSocketData::Text(text) => (text.as_bytes(), false),
            WebSocketData::Bytes(bytes) => (bytes.as_slice(), true),
        };
        result(ffi::websocket_send(self.id, bytes, binary))
    }
    fn close(&mut self, code: u16, reason: &str) -> Result<(), String> {
        result(ffi::websocket_close(self.id, code, reason))
    }
    fn buffered_amount(&self) -> usize {
        ffi::websocket_buffered(self.id)
    }
    /// The browser's WebSocket API has no flow control: the page holds the
    /// socket's events, in order, outside the WebAssembly memory until it
    /// resumes.
    fn pause(&mut self, paused: bool) {
        ffi::websocket_pause(self.id, paused);
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        LIVE.with(|s| s.borrow_mut().remove(&self.id));
        SOCKETS.with(|s| s.borrow_mut().remove(&self.id));
        ffi::websocket_cancel(self.id);
    }
}
fn result(ok: bool) -> Result<(), String> {
    let reply = REPLY.with(|r| r.borrow_mut().take());
    if ok {
        Ok(())
    } else {
        Err(reply.unwrap_or_else(|| "Browser WebSocket operation failed".into()))
    }
}

/// Receives a synchronous browser operation error without entering the engine.
///
/// # Safety
/// `ptr..ptr + len` is memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_websocket_reply(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let reply = unsafe { crate::string(ptr, len) };
    REPLY.with(|r| *r.borrow_mut() = Some(reply));
}

/// Receives an asynchronous browser socket event, then pumps the engine.
/// Kinds: open, text, bytes, error, close (0 through 4).
///
/// # Safety
/// `ptr..ptr + len` is memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_websocket_event(
    id: u32,
    kind: u32,
    ptr: *const u8,
    len: usize,
    code: u32,
    clean: u32,
) -> f64 {
    // Bound peer data before constructing a slice-backed owned message. The
    // browser bridge also checks before copying into wasm, but Rust owns the limit.
    if len > 8 * 1024 * 1024 {
        let callback = SOCKETS.with(|s| s.borrow_mut().remove(&id));
        if let Some(mut callback) = callback {
            callback(WebSocketEvent::Error(
                "WebSocket message exceeds the 8 MiB limit".into(),
            ));
            if LIVE.with(|s| s.borrow().contains(&id)) {
                callback(WebSocketEvent::Close {
                    code: 1009,
                    reason: "WebSocket message exceeds the 8 MiB limit".into(),
                    was_clean: false,
                });
            }
        }
        LIVE.with(|s| s.borrow_mut().remove(&id));
        ffi::websocket_cancel(id);
        return crate::pump();
    }
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { crate::bytes(ptr, len) };
    let text = || String::from_utf8_lossy(bytes).into_owned();
    let event = match kind {
        0 => WebSocketEvent::Open { protocol: text() },
        1 => WebSocketEvent::Message(WebSocketData::Text(text())),
        2 => WebSocketEvent::Message(WebSocketData::Bytes(bytes.to_vec())),
        3 => WebSocketEvent::Error(text()),
        4 => WebSocketEvent::Close {
            code: code as u16,
            reason: text(),
            was_clean: clean != 0,
        },
        _ => return crate::pump(),
    };
    // The callback may drop its task: do not hold a table borrow while invoking it.
    let callback = SOCKETS.with(|s| s.borrow_mut().remove(&id));
    if let Some(mut callback) = callback {
        callback(event);
        if kind != 4 && LIVE.with(|s| s.borrow().contains(&id)) {
            SOCKETS.with(|s| s.borrow_mut().insert(id, callback));
        }
    }
    crate::pump()
}
