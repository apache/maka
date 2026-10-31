//! `websocket`: an explicit WebSocket client. `connect(url, options)`
//! resolves a [`WebSocketConnection`] whose `read()` takes the messages in
//! arrival order; either the host transport (the browser's WebSocket API)
//! or the native socket (`native.rs`) drives its I/O, both with bounded
//! messages and queues.
//!
//! Every call returns a promise, and every failure rejects it: a URL the
//! app's network capabilities do not grant with `ERR_ACCESS_DENIED`
//! (`permission` `"network"`, `resource` the URL), a used-up quota (32
//! connections per VM, 8 MiB of writes waiting) with
//! `ERR_NSH_QUOTA_EXCEEDED`, a deadline with `ETIMEDOUT`, a connection
//! that ended without a close handshake (or is used after it ended) with
//! `ERR_SOCKET_CLOSED`, a protocol violation with `EPROTO`, a socket error
//! with the OS's code, a close code or reason out of range with a
//! `RangeError` (`ERR_OUT_OF_RANGE`).
//!
//! A connection that closes cleanly is no failure: once its close
//! handshake completed (started by the peer or by `close(code, reason)`)
//! and every message received before it was read, `read()` resolves
//! `null`, as `net`'s `Socket.read()` does at the end of the stream, and
//! `closeCode` / `closeReason` tell the close frame's code and reason
//! (1005 for a frame without a code, 1006 for a connection that ended
//! without one).
//!
//! Unread messages are back pressure, not a failure: while 8 messages or
//! 8 MiB wait to be read, the connection stops reading from the network
//! (the native socket is not polled, so TCP holds the peer back; a host
//! transport is paused, [`WebSocketTask::pause`]) and resumes as the app
//! reads. The memory a connection keeps stays bounded: what crossed the
//! threshold is at most one message of 8 MiB more.
use std::{
    cell::RefCell,
    collections::VecDeque,
    future::poll_fn,
    rc::Rc,
    task::{Poll, Waker},
};

use super::{MAX_WEBSOCKETS, WEBSOCKETS};
use crate::{
    JsonValue,
    element::{
        Held, JsError, JsHost, JsIn, JsOwned, JsValue, Later, PropError, System, TsTypes, class,
        codes, module,
    },
    websocket::{WebSocketData, WebSocketEvent, WebSocketRequest, WebSocketTask},
};
#[cfg(not(target_arch = "wasm32"))]
mod native;
/// The largest message one write sends or one read returns, and the bytes
/// of unread messages past which reading pauses.
const LIMIT: usize = 8 * 1024 * 1024;
/// Unread messages at which reading pauses.
const UNREAD: usize = 8;
/// The longest close reason, in UTF-8 bytes: what fits a control frame's
/// 125 bytes after the code (RFC 6455 5.5).
const MAX_REASON: usize = 123;
/// The close code of a connection that ended without a close frame.
const ABNORMAL: u16 = 1006;

/// The connection is closed: by the app, by the peer, or after a failure.
fn closed(message: impl Into<String>) -> JsError {
    JsError::Error(message.into()).with_code("ERR_SOCKET_CLOSED")
}

/// `operation` ran out of time.
fn timed_out(operation: &str) -> JsError {
    JsError::Error(format!("{operation} timed out")).with_code(codes::TIMED_OUT)
}

/// A quota of the connection or the VM is used up.
fn exceeded(message: String) -> JsError {
    JsError::Error(message).with_code(codes::QUOTA_EXCEEDED)
}

/// What the app's capabilities do not grant: a WebSocket to `url`.
fn denied(url: &str) -> JsError {
    JsError::access_denied(
        format!(
            "a WebSocket to `{url}` is not granted; add its host to capabilities.network.hosts or a GET rule in capabilities.network.http"
        ),
        "network",
        url,
    )
}

/// The VM's place for one more WebSocket.
fn slot(sys: &System) -> Result<Held, JsError> {
    sys.quotas.take(WEBSOCKETS, MAX_WEBSOCKETS).ok_or_else(|| {
        exceeded(format!(
            "At most {MAX_WEBSOCKETS} concurrent WebSockets are allowed per VM"
        ))
    })
}

/// A connection's close frame: the code and reason it closed with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloseStatus {
    /// The close code.
    code: u16,
    /// The close reason.
    reason: String,
}

impl CloseStatus {
    /// A connection that ended without a close frame.
    fn abnormal() -> Self {
        Self {
            code: ABNORMAL,
            reason: String::new(),
        }
    }

    /// `close(code, reason)`'s frame, checked as the WHATWG `close()`
    /// checks it (RFC 6455 7.4): a code of 1000 (the default) or
    /// 3000–4999, a reason of at most 123 UTF-8 bytes.
    fn requested(code: Option<f64>, reason: Option<String>) -> Result<Self, JsError> {
        let reason = reason.unwrap_or_default();
        if reason.len() > MAX_REASON {
            return Err(JsError::Range(format!(
                "WebSocket close reason of {} bytes exceeded the {MAX_REASON} byte limit",
                reason.len()
            ))
            .with_code("ERR_OUT_OF_RANGE"));
        }
        let code = code.unwrap_or(1000.0);
        if code != 1000.0 && !((3000.0..=4999.0).contains(&code) && code.fract() == 0.0) {
            return Err(JsError::Range(format!(
                "WebSocket close code {code} is neither 1000 nor an integer from 3000 to 4999"
            ))
            .with_code("ERR_OUT_OF_RANGE"));
        }
        Ok(Self {
            code: code as u16,
            reason,
        })
    }
}

/// `connect`'s options.
#[derive(Debug, Default)]
pub(crate) struct ConnectOptions {
    /// Extra handshake headers, checked in the call.
    headers: Vec<(String, String)>,
}

impl JsValue for ConnectOptions {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("WebSocketConnectOptions", |_| {
            "/** `connect`'s options. */\nexport interface WebSocketConnectOptions {\n  /** Extra handshake headers; credentials and handshake-control headers are refused. */\n  headers?: Record<string, string>;\n}".into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let expected = "an object with headers";
        let JsonValue::Object(options) = value.to_json()? else {
            return Err(value.expected(expected));
        };
        if let Some(key) = options.keys().find(|key| *key != "headers") {
            return Err(PropError(format!(
                "unknown option `{key}` for connect(url, options); expected headers"
            )));
        }
        let headers = match options.get("headers") {
            None | Some(JsonValue::Null) => serde_json::Map::new(),
            Some(JsonValue::Object(headers)) => headers.clone(),
            Some(_) => {
                return Err(PropError(
                    "headers: expected a plain object of string values".into(),
                ));
            }
        };
        let mut out = Vec::with_capacity(headers.len());
        for (name, value) in headers {
            let normalized = name.to_ascii_lowercase();
            if matches!(
                normalized.as_str(),
                "authorization"
                    | "proxy-authorization"
                    | "cookie"
                    | "host"
                    | "connection"
                    | "upgrade"
            ) || normalized.starts_with("sec-websocket-")
            {
                return Err(PropError(format!(
                    "headers may not set handshake-control or credential header `{name}`"
                )));
            }
            if normalized.is_empty()
                || !normalized
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            {
                return Err(PropError(format!("invalid header name `{name}`")));
            }
            let name = normalized;
            let JsonValue::String(value) = value else {
                return Err(PropError("headers: expected string header values".into()));
            };
            if value.bytes().any(|b| (b < 32 && b != b'\t') || b == 127) {
                return Err(PropError(format!("invalid value of header `{name}`")));
            }
            out.push((name, value));
        }
        Ok(Self { headers: out })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let headers: serde_json::Map<String, JsonValue> = self
            .headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone().into()))
            .collect();
        JsonValue::Object(
            [("headers".to_owned(), headers.into())]
                .into_iter()
                .collect(),
        )
        .to_js(host)
    }
}

/// One message: text or bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Data {
    /// A text message.
    Text(String),
    /// A binary message.
    Bytes(Vec<u8>),
}

impl JsValue for Data {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | Uint8Array".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(text) = value.as_string() {
            return Ok(Self::Text(text));
        }
        value
            .as_bytes()
            .map(Self::Bytes)
            .ok_or_else(|| value.expected("a string or Uint8Array"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Text(text) => text.to_js(host),
            Self::Bytes(bytes) => bytes.to_js(host),
        }
    }
}

/// WebSocket clients under the app's network capabilities.
#[module]
pub(crate) struct WebSocket;

#[module(flat, default)]
impl WebSocket {
    /// Connects to a ws/wss URL allowed by capabilities.network; up to 32
    /// connections are shared with the global WebSocket constructor. A bad
    /// URL or option rejects with a `TypeError`, a URL not granted with
    /// `ERR_ACCESS_DENIED`, the 33rd connection with
    /// `ERR_NSH_QUOTA_EXCEEDED`, a failed handshake with the OS's code or
    /// `EPROTO`, a slow one with `ETIMEDOUT`, one the host refuses (a
    /// test's network) with the host's error.
    pub(crate) fn connect(
        url: String,
        options: Option<ConnectOptions>,
        sys: System,
    ) -> Result<Later<WebSocketConnection>, JsError> {
        let Some(transport) = sys.websocket.clone() else {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let connection = native::WebSocket::connect(url, options, sys)?;
                return Ok(Later::new(async move {
                    connection.await.map(|connection| WebSocketConnection {
                        inner: Connection::Native(connection),
                    })
                }));
            }
            #[cfg(target_arch = "wasm32")]
            return Err(
                JsError::Error("The host has no WebSocket transport configured".into())
                    .with_code(codes::UNAVAILABLE),
            );
        };
        let parsed = url::Url::parse(&url)
            .map_err(|error| JsError::Type(format!("invalid WebSocket URL: {error}")))?;
        if !matches!(parsed.scheme(), "ws" | "wss")
            || parsed.host_str().is_none()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(JsError::Type(
                "connect(url) expects a ws:// or wss:// URL without credentials or fragment".into(),
            ));
        }
        if !sys.access.allows_websocket(parsed.as_str()) {
            return Err(denied(parsed.as_str()));
        }
        sys.check_connection(parsed.as_str())?;
        let headers = options.map(|options| options.headers).unwrap_or_default();
        if !headers.is_empty() && !transport.supports_headers() {
            return Err(JsError::Type(
                "The browser WebSocket API does not support custom handshake headers".into(),
            ));
        }
        let held = slot(&sys)?;
        let state = Rc::new(RefCell::new(HostState {
            held: Some(held),
            ..HostState::default()
        }));
        let events = state.clone();
        // The transport owns the callback; its weak task reference in State
        // lets an ending connection cancel I/O without retaining a cycle.
        let task = transport.connect(
            WebSocketRequest {
                url: parsed.into(),
                protocols: Vec::new(),
                headers,
            },
            Box::new(move |event| HostState::event(&events, event)),
        );
        Ok(Later::new(async move {
            let task = task.map_err(JsError::Error)?;
            let task = Rc::new(RefCell::new(Some(task)));
            state.borrow_mut().task = Rc::downgrade(&task);
            let host = HostConnection { task, state };
            let opening = host.state.clone();
            timeout(
                "WebSocket handshake",
                poll_fn(move |cx| {
                    let mut state = opening.borrow_mut();
                    if state.open {
                        Poll::Ready(Ok(()))
                    } else if let Some(error) = &state.error {
                        Poll::Ready(Err(error.clone()))
                    } else if state.status.is_some() {
                        Poll::Ready(Err(closed("WebSocket closed during the handshake")))
                    } else {
                        state.waker = Some(cx.waker().clone());
                        Poll::Pending
                    }
                }),
            )
            .await?;
            Ok::<_, JsError>(WebSocketConnection {
                inner: Connection::Host(host),
            })
        }))
    }
}

enum Connection {
    #[cfg(not(target_arch = "wasm32"))]
    Native(native::WebSocketConnection),
    Host(HostConnection),
}

/// An open connection with one outstanding read and bounded incoming data.
#[class]
pub(crate) struct WebSocketConnection {
    inner: Connection,
}

#[class]
impl WebSocketConnection {
    /// Sends a string or Uint8Array of at most 8 MiB (a `RangeError` with
    /// `ERR_OUT_OF_RANGE` past it); at most 8 MiB may wait to be sent
    /// (`ERR_NSH_QUOTA_EXCEEDED`). After the connection ended it rejects
    /// with `ERR_SOCKET_CLOSED`.
    pub(crate) fn write(&self, data: Data) -> Result<Later<()>, JsError> {
        match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.write(data),
            Connection::Host(host) => {
                let data = match data {
                    Data::Text(text) => WebSocketData::Text(text),
                    Data::Bytes(bytes) => WebSocketData::Bytes(bytes),
                };
                if data.len() > LIMIT {
                    return Err(too_long(data.len()));
                }
                let mut task = host.task.borrow_mut();
                let result = match task.as_mut() {
                    None => Err(closed("WebSocket connection is closed")),
                    Some(task) => {
                        if task.buffered_amount().saturating_add(data.len()) > LIMIT {
                            return Err(exceeded(format!(
                                "WebSocket writes waiting to be sent exceeded the {LIMIT} byte limit"
                            )));
                        }
                        task.send(data).map_err(JsError::Error)
                    }
                };
                let state = host.state.clone();
                let task = host.task.clone();
                Ok(Later::new(async move {
                    if let Err(error) = result {
                        HostState::fail(&state, error.clone());
                        return Err(error);
                    }
                    let sent = timeout("WebSocket write", async {
                        loop {
                            {
                                if let Some(error) = &state.borrow().error {
                                    return Err(error.clone());
                                }
                                let task = task.borrow();
                                let Some(task) = task.as_ref() else {
                                    return Err(closed("WebSocket connection is closed"));
                                };
                                if task.buffered_amount() == 0 {
                                    return Ok(());
                                }
                            }
                            // Browsers expose pending bytes but no drain event.
                            crate::element::timer(std::time::Duration::from_millis(10)).await;
                        }
                    })
                    .await;
                    if let Err(error) = &sent {
                        HostState::fail(&state, error.clone());
                    }
                    sent
                }))
            }
        }
    }

    /// Reads the next string or Uint8Array, in arrival order. Once the
    /// connection closed cleanly and what arrived before was read, it
    /// resolves `null`; a connection that failed rejects instead, with why
    /// (`ERR_SOCKET_CLOSED` for one that ended without a close handshake,
    /// `ETIMEDOUT`, `EPROTO`, the OS's code). While 8 messages or 8 MiB wait
    /// unread, the connection stops reading from the network until this
    /// takes one.
    pub(crate) fn read(&self) -> Result<Later<Option<Data>>, JsError> {
        match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.read(),
            Connection::Host(host) => {
                if host.state.borrow_mut().reading.replace(true) {
                    return Err(busy());
                }
                let reading = Reading(host.state.clone());
                let task = host.task.clone();
                Ok(Later::new(async move {
                    poll_fn(|cx| {
                        let mut state = reading.0.borrow_mut();
                        let message = state.messages.pop_front();
                        if let Some(message) = message {
                            state.bytes -= message.len();
                            let resume = state.paused && !state.full();
                            if resume {
                                state.paused = false;
                            }
                            drop(state);
                            if resume && let Some(task) = task.borrow_mut().as_mut() {
                                task.pause(false);
                            }
                            Poll::Ready(Ok(Some(match message {
                                WebSocketData::Text(text) => Data::Text(text),
                                WebSocketData::Bytes(bytes) => Data::Bytes(bytes),
                            })))
                        } else if let Some(error) = &state.error {
                            Poll::Ready(Err(error.clone()))
                        } else if state.status.is_some() {
                            Poll::Ready(Ok(None))
                        } else {
                            state.waker = Some(cx.waker().clone());
                            Poll::Pending
                        }
                    })
                    .await
                }))
            }
        }
    }

    /// Closes the connection with `code` (1000, the default, or 3000–4999)
    /// and `reason` (at most 123 UTF-8 bytes; a `RangeError` with
    /// `ERR_OUT_OF_RANGE` past either), discards unread messages and
    /// resolves once the peer answered the close handshake; `read()` then
    /// resolves `null`.
    pub(crate) fn close(
        &self,
        code: Option<f64>,
        reason: Option<String>,
    ) -> Result<Later<()>, JsError> {
        let frame = CloseStatus::requested(code, reason)?;
        Ok(match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.close(frame),
            Connection::Host(host) => {
                let paused = {
                    let mut state = host.state.borrow_mut();
                    state.messages.clear();
                    state.bytes = 0;
                    // What arrives from now on is dropped, and the close
                    // handshake's reply must reach the state.
                    state.closing = true;
                    std::mem::take(&mut state.paused)
                };
                let result = host
                    .task
                    .borrow_mut()
                    .as_mut()
                    .map(|task| {
                        if paused {
                            task.pause(false);
                        }
                        task.close(frame.code, &frame.reason)
                            .map_err(JsError::Error)
                    })
                    .unwrap_or(Ok(()));
                let state = host.state.clone();
                let task = host.task.clone();
                Later::new(async move {
                    let _transport = task;
                    if let Err(error) = result {
                        HostState::fail(&state, error.clone());
                        return Err(error);
                    }
                    let closed = timeout(
                        "WebSocket close",
                        poll_fn(|cx| {
                            let mut state = state.borrow_mut();
                            if state.status.is_some() {
                                Poll::Ready(Ok(()))
                            } else {
                                if !state
                                    .close_wakers
                                    .iter()
                                    .any(|waker| waker.will_wake(cx.waker()))
                                {
                                    state.close_wakers.push(cx.waker().clone());
                                }
                                Poll::Pending
                            }
                        }),
                    )
                    .await;
                    if let Err(error) = &closed {
                        HostState::fail(&state, error.clone());
                    }
                    closed
                })
            }
        })
    }

    /// The code of the close frame the connection closed with: the peer's
    /// (1005 when it had none), 1006 when the connection ended without one;
    /// `null` while it is open.
    #[getter]
    pub(crate) fn close_code(&self) -> Option<u16> {
        self.status().map(|status| status.code)
    }

    /// The reason of the close frame the connection closed with (`""` when
    /// it had none); `null` while it is open.
    #[getter]
    pub(crate) fn close_reason(&self) -> Option<String> {
        self.status().map(|status| status.reason)
    }

    /// How the connection closed, once it did.
    fn status(&self) -> Option<CloseStatus> {
        match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.status(),
            Connection::Host(host) => host.state.borrow().status.clone(),
        }
    }
}

/// A write of `len` bytes, past the one-message limit.
fn too_long(len: usize) -> JsError {
    JsError::Range(format!(
        "WebSocket write of {len} bytes exceeded the {LIMIT} byte limit"
    ))
    .with_code("ERR_OUT_OF_RANGE")
}

/// A second read while one waits: a wrong use.
fn busy() -> JsError {
    JsError::Type("WebSocketConnection.read() already has an outstanding read".into())
}

async fn timeout<T>(
    operation: &str,
    work: impl Future<Output = Result<T, JsError>>,
) -> Result<T, JsError> {
    use std::future::Future;
    let mut work = std::pin::pin!(work);
    let mut timer = std::pin::pin!(crate::element::timer(std::time::Duration::from_secs(30)));
    poll_fn(|cx| {
        if let Poll::Ready(result) = work.as_mut().poll(cx) {
            return Poll::Ready(result);
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(timed_out(operation)));
        }
        Poll::Pending
    })
    .await
}

struct HostConnection {
    task: Rc<RefCell<Option<Box<dyn WebSocketTask>>>>,
    state: Rc<RefCell<HostState>>,
}
impl Drop for HostConnection {
    fn drop(&mut self) {
        // An operation's promise may outlive its JS receiver, including
        // `await connect(...).close()`. Its task reference keeps the socket
        // alive until that operation completes or is cancelled.
        if Rc::strong_count(&self.task) > 1 {
            return;
        }
        HostState::fail(&self.state, closed("WebSocket connection is closed"));
        self.task.borrow_mut().take();
        self.state.borrow_mut().held.take();
    }
}
struct Reading(Rc<RefCell<HostState>>);
impl Drop for Reading {
    fn drop(&mut self) {
        self.0.borrow_mut().reading.set(false);
    }
}

#[derive(Default)]
struct HostState {
    open: bool,
    /// How the connection closed, once it ended (cleanly or not).
    status: Option<CloseStatus>,
    /// Why the connection failed, which reads reject with once the
    /// messages before it are read; `None` for a clean close, after which
    /// reads resolve `null`.
    error: Option<JsError>,
    messages: VecDeque<WebSocketData>,
    bytes: usize,
    /// The transport is paused: the unread messages fill their queue.
    paused: bool,
    /// The app closed the connection: what arrives is dropped.
    closing: bool,
    reading: std::cell::Cell<bool>,
    waker: Option<Waker>,
    close_wakers: Vec<Waker>,
    held: Option<Held>,
    task: std::rc::Weak<RefCell<Option<Box<dyn WebSocketTask>>>>,
}
impl HostState {
    /// Whether the unread messages fill their queue: reading pauses.
    fn full(&self) -> bool {
        self.messages.len() >= UNREAD || self.bytes >= LIMIT
    }

    /// Ends the connection with `error`, as a transport event would.
    fn fail(shared: &Rc<RefCell<Self>>, error: JsError) {
        Self::apply(shared, Err(error));
    }

    fn event(shared: &Rc<RefCell<Self>>, event: WebSocketEvent) {
        Self::apply(shared, Ok(event));
    }

    fn apply(shared: &Rc<RefCell<Self>>, event: Result<WebSocketEvent, JsError>) {
        let mut state = shared.borrow_mut();
        if state.status.is_some() {
            return;
        }
        let mut pause = false;
        match event {
            Err(error) => state.end(CloseStatus::abnormal(), Some(error)),
            Ok(WebSocketEvent::Open { .. }) => state.open = true,
            Ok(WebSocketEvent::Message(_)) if state.closing => {}
            Ok(WebSocketEvent::Message(message)) => {
                // A paused transport may still deliver what was on its way;
                // twice the queue bounds a transport that keeps delivering.
                if message.len() > LIMIT
                    || state.messages.len() >= 2 * UNREAD
                    || state.bytes.saturating_add(message.len()) > 2 * LIMIT
                {
                    state.end(
                        CloseStatus::abnormal(),
                        Some(exceeded(format!(
                            "WebSocket closed: the transport kept delivering while {UNREAD} messages or {LIMIT} bytes waited unread"
                        ))),
                    );
                } else {
                    state.bytes += message.len();
                    state.messages.push_back(message);
                    if !state.paused && state.full() {
                        state.paused = true;
                        pause = true;
                    }
                }
            }
            // The browser reports no reason: the connection failed.
            Ok(WebSocketEvent::Error(error)) => {
                state.end(CloseStatus::abnormal(), Some(closed(error)))
            }
            Ok(WebSocketEvent::Close {
                code,
                reason,
                was_clean,
            }) => {
                let error = (!was_clean).then(|| {
                    closed(format!(
                        "WebSocket connection ended without a close handshake ({code})"
                    ))
                });
                state.end(CloseStatus { code, reason }, error);
            }
        }
        let task = if state.status.is_some() {
            state.held.take();
            state.task.upgrade()
        } else {
            None
        };
        let paused = pause.then(|| state.task.upgrade()).flatten();
        let waker = state.waker.take();
        let close_wakers = std::mem::take(&mut state.close_wakers);
        drop(state);
        if let Some(task) = paused
            && let Some(task) = task.borrow_mut().as_mut()
        {
            task.pause(true);
        }
        if let Some(task) = task {
            task.borrow_mut().take();
        }
        if let Some(waker) = waker {
            waker.wake();
        }
        for waker in close_wakers {
            waker.wake();
        }
    }

    /// The connection ended: closed with `status`, failed with `error`.
    fn end(&mut self, status: CloseStatus, error: Option<JsError>) {
        self.status = Some(status);
        self.error = error;
    }
}

#[cfg(test)]
mod tests {
    /// What `later` settles JS's promise with: its value as JSON (`null`
    /// for `undefined` too), or its error's `code`.
    async fn settled<T: crate::element::Ret + 'static>(
        later: crate::element::Later<T>,
    ) -> Result<serde_json::Value, Option<String>> {
        match later.into_future().await {
            Ok(value) => Ok(crate::element::json_host::result(Ok(value))
                .unwrap()
                .unwrap_or_default()),
            Err(crate::element::Thrown::Fields(fields)) => Err(fields
                .field("code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)),
            Err(_) => Err(None),
        }
    }

    use std::{cell::Cell, sync::Arc};

    use super::*;
    use crate::{
        access::Access,
        websocket::{WebSocketEvents, WebSocketTransport},
    };

    thread_local! {
        static EVENTS:RefCell<Option<WebSocketEvents>>=RefCell::new(None);
        static DROPS:Cell<usize>=const {Cell::new(0)};
        static PAUSES:RefCell<Vec<bool>>=const {RefCell::new(Vec::new())};
    }
    struct Browser;
    struct Task {
        buffered: usize,
    }
    impl Drop for Task {
        fn drop(&mut self) {
            DROPS.with(|drops| drops.set(drops.get() + 1));
        }
    }
    impl WebSocketTask for Task {
        fn send(&mut self, _data: WebSocketData) -> Result<(), String> {
            Ok(())
        }
        fn close(&mut self, _code: u16, _reason: &str) -> Result<(), String> {
            Ok(())
        }
        fn buffered_amount(&self) -> usize {
            self.buffered
        }
        fn pause(&mut self, paused: bool) {
            PAUSES.with(|pauses| pauses.borrow_mut().push(paused));
        }
    }
    impl WebSocketTransport for Browser {
        fn supports_headers(&self) -> bool {
            false
        }
        fn connect(
            &self,
            request: WebSocketRequest,
            events: WebSocketEvents,
        ) -> Result<Box<dyn WebSocketTask>, String> {
            assert_eq!(request.url, "ws://example.com/");
            EVENTS.with(|slot| *slot.borrow_mut() = Some(events));
            Ok(Box::new(Task { buffered: 0 }))
        }
    }
    fn system() -> System {
        let mut sys = System::default().with_websocket(Some(Arc::new(Browser)));
        sys.access = Arc::new(Access::all());
        sys
    }
    fn emit(event: WebSocketEvent) {
        let mut callback = EVENTS.with(|events| events.borrow_mut().take().unwrap());
        callback(event);
        EVENTS.with(|events| *events.borrow_mut() = Some(callback));
    }
    fn poll<F: Future>(future: std::pin::Pin<&mut F>) -> Poll<F::Output> {
        future.poll(&mut std::task::Context::from_waker(Waker::noop()))
    }

    // Android has no other dependency selecting a TLS provider. A peer closing
    // at once must produce a handshake error, not a missing-provider panic.
    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn native_wss_has_a_tls_provider() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                drop(stream);
            }
        });
        let sys = System {
            access: Arc::new(Access::all()),
            ..System::default()
        };
        let connect = WebSocket::connect(format!("wss://127.0.0.1:{port}"), None, sys).unwrap();
        let result = std::panic::AssertUnwindSafe(connect.into_future());
        let outcome = futures_util::FutureExt::catch_unwind(result).await;
        let message = match outcome {
            Ok(Ok(_)) => panic!("a peer that closes at once cannot complete a TLS handshake"),
            Ok(Err(error)) => error.to_string(),
            Err(panic) => panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default(),
        };
        assert!(!message.contains("CryptoProvider"), "{message}");
        assert!(message.contains("WebSocket handshake failed"), "{message}");
    }

    #[tokio::test]
    async fn host_connect_waits_for_open_and_releases_its_slot_on_drop() {
        DROPS.with(|drops| drops.set(0));
        let sys = system();
        let connect = WebSocket::connect("ws://example.com".into(), None, sys.clone()).unwrap();
        assert_eq!(sys.quotas.held(WEBSOCKETS), 1);
        let mut pending = std::pin::pin!(connect.into_future());
        assert!(poll(pending.as_mut()).is_pending());
        emit(WebSocketEvent::Open {
            protocol: String::new(),
        });
        let Poll::Ready(Ok(connection)) = poll(pending.as_mut()) else {
            panic!("handshake did not complete")
        };
        assert_eq!(sys.quotas.held(WEBSOCKETS), 1);
        drop(connection);
        assert_eq!(sys.quotas.held(WEBSOCKETS), 0);
        DROPS.with(|drops| assert_eq!(drops.get(), 1));
        EVENTS.with(|events| events.borrow_mut().take());
    }

    #[test]
    fn a_host_refusing_connections_refuses_websockets_and_sockets() {
        let refuse: crate::element::RefuseConnections = Arc::new(|target: &str| {
            JsError::Error(format!("{target}: refused")).with_code("ERR_TEST_REFUSED")
        });
        let host = system().with_refuse_connections(Some(refuse.clone()));
        let Err(error) = WebSocket::connect("ws://example.com".into(), None, host.clone()) else {
            panic!("a refused WebSocket connected")
        };
        assert_eq!(error.code(), Some("ERR_TEST_REFUSED"));
        assert_eq!(error.message(), "ws://example.com/: refused");
        assert_eq!(host.quotas.held(WEBSOCKETS), 0);
        let sockets = serde_json::json!({ "network": { "hosts": ["*"], "sockets": ["[::1]:7"] } });
        let native = System {
            access: Arc::new(Access {
                declared: crate::access::Capabilities::from_json(&sockets).unwrap(),
                granted: None,
            }),
            ..System::default()
        }
        .with_refuse_connections(Some(refuse));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let Err(error) = WebSocket::connect("ws://example.com".into(), None, native.clone())
            else {
                panic!("a refused WebSocket connected")
            };
            assert_eq!(error.code(), Some("ERR_TEST_REFUSED"));
        }
        let options = super::super::net::ConnectOptions {
            host: "::1".into(),
            port: 7,
        };
        let Err(error) = super::super::net::Net::connect(options, native.clone()) else {
            panic!("a refused socket connected")
        };
        assert_eq!(error.code(), Some("ERR_TEST_REFUSED"));
        assert_eq!(error.message(), "[::1]:7: refused");
        assert_eq!(native.quotas.held("net.sockets"), 0);
    }

    #[test]
    fn host_checks_grants_headers_and_shared_quota_before_connecting() {
        let mut denied = system();
        denied.access = Arc::new(Access {
            declared: crate::access::Capabilities::default(),
            granted: None,
        });
        let Err(error) = WebSocket::connect("ws://example.com".into(), None, denied) else {
            panic!("an ungranted URL connected")
        };
        assert_eq!(error.code(), Some(codes::ACCESS_DENIED));
        let sys = system();
        let headers = ConnectOptions {
            headers: vec![("x-test".into(), "test".into())],
        };
        assert!(WebSocket::connect("ws://example.com".into(), Some(headers), sys.clone()).is_err());
        let _held = sys
            .quotas
            .reserve(WEBSOCKETS, MAX_WEBSOCKETS, MAX_WEBSOCKETS)
            .unwrap();
        let Err(error) = WebSocket::connect("ws://example.com".into(), None, sys) else {
            panic!("the 33rd WebSocket connected")
        };
        assert_eq!(error.code(), Some(codes::QUOTA_EXCEEDED));
    }

    fn host(buffered: usize) -> WebSocketConnection {
        let task = Rc::new(RefCell::new(Some(
            Box::new(Task { buffered }) as Box<dyn WebSocketTask>
        )));
        let state = Rc::new(RefCell::new(HostState {
            open: true,
            task: Rc::downgrade(&task),
            ..HostState::default()
        }));
        WebSocketConnection {
            inner: Connection::Host(HostConnection { task, state }),
        }
    }

    fn clean_close(state: &Rc<RefCell<HostState>>, code: u16, reason: &str) {
        HostState::event(
            state,
            WebSocketEvent::Close {
                code,
                reason: reason.into(),
                was_clean: true,
            },
        );
    }

    #[tokio::test]
    async fn host_reads_what_came_before_a_clean_close_then_null() {
        let connection = host(LIMIT);
        assert!(connection.write(Data::Text("x".into())).is_err());
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        HostState::event(
            &host.state,
            WebSocketEvent::Message(WebSocketData::Text("before close".into())),
        );
        assert_eq!(connection.close_code(), None);
        clean_close(&host.state, 4000, "done");
        assert_eq!(connection.close_code(), Some(4000));
        assert_eq!(connection.close_reason().as_deref(), Some("done"));
        assert_eq!(
            settled(connection.read().unwrap()).await,
            Ok(serde_json::json!("before close"))
        );
        assert_eq!(
            settled(connection.read().unwrap()).await,
            Ok(serde_json::json!(null))
        );
        assert_eq!(
            settled(connection.read().unwrap()).await,
            Ok(serde_json::json!(null))
        );
    }

    #[tokio::test]
    async fn host_rejects_reads_after_a_connection_that_ended_without_a_handshake() {
        let connection = host(0);
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        HostState::event(
            &host.state,
            WebSocketEvent::Close {
                code: 1006,
                reason: String::new(),
                was_clean: false,
            },
        );
        let error = settled(connection.read().unwrap()).await.unwrap_err();
        assert_eq!(error.as_deref(), Some("ERR_SOCKET_CLOSED"));
        assert_eq!(connection.close_code(), Some(ABNORMAL));
        assert_eq!(connection.close_reason().as_deref(), Some(""));
    }

    #[tokio::test]
    async fn host_pauses_the_transport_while_the_unread_queue_is_full() {
        PAUSES.with(|pauses| pauses.borrow_mut().clear());
        let connection = host(0);
        let reading = connection.read().unwrap();
        assert!(connection.read().is_err());
        drop(reading);
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        let message = || WebSocketEvent::Message(WebSocketData::Bytes(vec![1]));
        for _ in 0..UNREAD {
            HostState::event(&host.state, message());
        }
        PAUSES.with(|pauses| assert_eq!(*pauses.borrow(), [true]));
        // What was on its way still arrives and is kept.
        HostState::event(&host.state, message());
        assert!(host.task.borrow().is_some());
        assert!(host.state.borrow().error.is_none());
        assert_eq!(host.state.borrow().messages.len(), UNREAD + 1);
        // Reading below the threshold resumes the transport.
        for _ in 0..2 {
            assert!(
                settled(connection.read().unwrap())
                    .await
                    .is_ok_and(|v| !v.is_null())
            );
        }
        PAUSES.with(|pauses| assert_eq!(*pauses.borrow(), [true, false]));
        // A transport that keeps delivering past twice the queue fails.
        for _ in 0..=UNREAD + 1 {
            HostState::event(&host.state, message());
        }
        assert!(host.task.borrow().is_none());
        assert_eq!(
            host.state.borrow().error.as_ref().unwrap().code(),
            Some(codes::QUOTA_EXCEEDED)
        );
        assert_eq!(connection.close_code(), Some(ABNORMAL));
    }

    #[tokio::test]
    async fn host_close_sends_its_frame_and_drops_unread_messages() {
        let connection = host(0);
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        let state = host.state.clone();
        HostState::event(
            &state,
            WebSocketEvent::Message(WebSocketData::Text("unread".into())),
        );
        let mut close = std::pin::pin!(
            connection
                .close(Some(4001.0), Some("bye".into()))
                .unwrap()
                .into_future()
        );
        assert!(poll(close.as_mut()).is_pending());
        // Arriving before the peer's reply: dropped.
        HostState::event(
            &state,
            WebSocketEvent::Message(WebSocketData::Text("late".into())),
        );
        clean_close(&state, 4001, "bye");
        assert!(matches!(poll(close.as_mut()), Poll::Ready(Ok(_))));
        assert_eq!(
            settled(connection.read().unwrap()).await,
            Ok(serde_json::json!(null))
        );
        assert_eq!(connection.close_code(), Some(4001));
    }

    #[test]
    fn close_codes_and_reasons_are_checked() {
        let requested = |code: Option<f64>, reason: &str| {
            CloseStatus::requested(code, Some(reason.into())).map(|status| status.code)
        };
        assert_eq!(requested(None, ""), Ok(1000));
        assert_eq!(requested(Some(1000.0), ""), Ok(1000));
        assert_eq!(requested(Some(3000.0), ""), Ok(3000));
        assert_eq!(requested(Some(4999.0), &"x".repeat(MAX_REASON)), Ok(4999));
        for code in [0.0, 999.0, 1001.0, 1005.0, 2999.0, 3000.5, 5000.0, f64::NAN] {
            let error = requested(Some(code), "").unwrap_err();
            assert!(
                matches!(&error, JsError::Fields(fields) if fields.class == crate::element::ErrorClass::Range),
                "{code}"
            );
            assert_eq!(error.code(), Some("ERR_OUT_OF_RANGE"));
        }
        // 124 bytes, as 62 two-byte characters.
        let error = requested(None, &"é".repeat(62)).unwrap_err();
        assert_eq!(error.code(), Some("ERR_OUT_OF_RANGE"));
    }

    #[tokio::test]
    async fn operations_keep_transport_alive_after_connection_is_collected() {
        let connection = host(0);
        let read = connection.read().unwrap();
        let close = connection.close(None, None).unwrap();
        let mut read = std::pin::pin!(read.into_future());
        let mut close = std::pin::pin!(close.into_future());
        assert!(poll(read.as_mut()).is_pending());
        assert!(poll(close.as_mut()).is_pending());
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        let state = host.state.clone();
        drop(connection);
        assert!(poll(read.as_mut()).is_pending());
        assert!(poll(close.as_mut()).is_pending());
        clean_close(&state, 1000, "");
        let Poll::Ready(Ok(read)) = poll(read.as_mut()) else {
            panic!("the read is settled")
        };
        assert_eq!(
            crate::element::json_host::result(Ok(read)),
            Ok(Some(serde_json::Value::Null))
        );
        assert!(matches!(poll(close.as_mut()), Poll::Ready(Ok(_))));
    }
}
