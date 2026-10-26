//! The explicit WebSocket client: capability and quota checks run in the
//! call, then either the host transport (the browser's WebSocket API) or
//! the native socket drives I/O. Both enforce bounded messages and queues.
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
        module,
    },
    websocket::{WebSocketData, WebSocketEvent, WebSocketRequest, WebSocketTask},
};
#[cfg(not(target_arch = "wasm32"))]
mod native;
const LIMIT: usize = 8 * 1024 * 1024;
const UNREAD: usize = 8;

/// `WebSocket.connect`'s options.
#[derive(Debug, Default)]
pub(crate) struct ConnectOptions {
    /// Extra handshake headers, checked in the call.
    headers: Vec<(String, String)>,
}

impl JsValue for ConnectOptions {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("WebSocketConnectOptions", |_| {
            "/** `WebSocket.connect`'s options. */\nexport interface WebSocketConnectOptions {\n  /** Extra handshake headers; credentials and handshake-control headers are refused. */\n  headers?: Record<string, string>;\n}".into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let expected = "an object with headers";
        let JsonValue::Object(options) = value.to_json()? else {
            return Err(value.expected(expected));
        };
        if let Some(key) = options.keys().find(|key| *key != "headers") {
            return Err(PropError(format!(
                "unknown option `{key}` for WebSocket.connect(url, options); expected headers"
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

#[module]
impl WebSocket {
    /// Connects to a ws/wss URL allowed by capabilities.network; up to 32
    /// connections are shared with the global WebSocket constructor.
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
            return Err(JsError::Type(
                "The host has no WebSocket transport configured".into(),
            ));
        };
        let parsed = url::Url::parse(&url)
            .map_err(|error| JsError::Type(format!("invalid WebSocket URL: {error}")))?;
        if !matches!(parsed.scheme(), "ws" | "wss")
            || parsed.host_str().is_none()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(JsError::Type("WebSocket.connect(url) expects a ws:// or wss:// URL without credentials or fragment".into()));
        }
        if !sys.access.allows_websocket(parsed.as_str()) {
            return Err(JsError::Type("WebSocket network capability denied".into()));
        }
        let headers = options.map(|options| options.headers).unwrap_or_default();
        if !headers.is_empty() && !transport.supports_headers() {
            return Err(JsError::Type(
                "The browser WebSocket API does not support custom handshake headers".into(),
            ));
        }
        let held = sys.quotas.take(WEBSOCKETS, MAX_WEBSOCKETS).ok_or_else(|| {
            JsError::Range(format!(
                "At most {MAX_WEBSOCKETS} concurrent WebSockets are allowed per VM"
            ))
        })?;
        let state = Rc::new(RefCell::new(HostState {
            held: Some(held),
            ..HostState::default()
        }));
        let events = state.clone();
        // The transport owns the callback; its weak task reference in State
        // lets an overflowing queue cancel I/O without retaining a cycle.
        let task = transport.connect(
            WebSocketRequest {
                url: parsed.into(),
                protocols: Vec::new(),
                headers,
            },
            Box::new(move |event| HostState::event(&events, event)),
        );
        Ok(Later::new(async move {
            let task = Rc::new(RefCell::new(Some(task?)));
            state.borrow_mut().task = Rc::downgrade(&task);
            let host = HostConnection { task, state };
            let opening = host.state.clone();
            timeout(
                "WebSocket handshake",
                poll_fn(move |cx| {
                    let mut state = opening.borrow_mut();
                    if state.open {
                        Poll::Ready(Ok::<_, String>(()))
                    } else if let Some(error) = &state.error {
                        Poll::Ready(Err(error.clone()))
                    } else {
                        state.waker = Some(cx.waker().clone());
                        Poll::Pending
                    }
                }),
            )
            .await?;
            Ok::<_, String>(WebSocketConnection {
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
    /// Sends a string or Uint8Array of at most 8 MiB; queued bytes are bounded.
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
                    return Err(JsError::Range(format!(
                        "WebSocket write exceeded the {LIMIT} byte limit"
                    )));
                }
                let mut task = host.task.borrow_mut();
                let result = match task.as_mut() {
                    None => Err("WebSocket connection is closed".to_owned()),
                    Some(task) => {
                        if task.buffered_amount().saturating_add(data.len()) > LIMIT {
                            return Err(JsError::Range(format!(
                                "WebSocket writes waiting to be sent exceeded the {LIMIT} byte limit"
                            )));
                        }
                        task.send(data)
                    }
                };
                let state = host.state.clone();
                let task = host.task.clone();
                Ok(Later::new(async move {
                    if let Err(error) = result {
                        HostState::event(&state, WebSocketEvent::Error(error.clone()));
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
                                    return Err("WebSocket connection is closed".into());
                                };
                                if task.buffered_amount() == 0 {
                                    return Ok(());
                                }
                            }
                            // Browsers expose pending bytes but no drain event.
                            crate::element::ambient::timer(std::time::Duration::from_millis(10))
                                .await;
                        }
                    })
                    .await;
                    if let Err(error) = &sent {
                        HostState::event(&state, WebSocketEvent::Error(error.clone()));
                    }
                    sent
                }))
            }
        }
    }

    /// Reads the next string or Uint8Array, in arrival order.
    pub(crate) fn read(&self) -> Result<Later<Data>, JsError> {
        match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.read(),
            Connection::Host(host) => {
                if host.state.borrow_mut().reading.replace(true) {
                    return Err(JsError::Type(
                        "WebSocket.read() already has an outstanding read".into(),
                    ));
                }
                let reading = Reading(host.state.clone());
                let task = host.task.clone();
                Ok(Later::new(async move {
                    let _transport = task;
                    poll_fn(|cx| {
                        let mut state = reading.0.borrow_mut();
                        if let Some(message) = state.messages.pop_front() {
                            state.bytes -= message.len();
                            Poll::Ready(Ok(match message {
                                WebSocketData::Text(text) => Data::Text(text),
                                WebSocketData::Bytes(bytes) => Data::Bytes(bytes),
                            }))
                        } else if let Some(error) = &state.error {
                            Poll::Ready(Err(error.clone()))
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

    /// Closes the connection and discards unread messages.
    pub(crate) fn close(&self) -> Later<()> {
        match &self.inner {
            #[cfg(not(target_arch = "wasm32"))]
            Connection::Native(connection) => connection.close(),
            Connection::Host(host) => {
                host.state.borrow_mut().messages.clear();
                host.state.borrow_mut().bytes = 0;
                let result = host
                    .task
                    .borrow_mut()
                    .as_mut()
                    .map(|task| task.close(1000, ""))
                    .unwrap_or(Ok(()));
                let state = host.state.clone();
                let task = host.task.clone();
                Later::new(async move {
                    let _transport = task;
                    if let Err(error) = result {
                        HostState::event(&state, WebSocketEvent::Error(error.clone()));
                        return Err(error);
                    }
                    let closed = timeout(
                        "WebSocket close",
                        poll_fn(|cx| {
                            let mut state = state.borrow_mut();
                            if state.error.is_some() {
                                Poll::Ready(Ok::<_, String>(()))
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
                        HostState::event(&state, WebSocketEvent::Error(error.clone()));
                    }
                    closed
                })
            }
        }
    }
}

async fn timeout<T>(
    operation: &str,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    use std::future::Future;
    let mut work = std::pin::pin!(work);
    let mut timer = std::pin::pin!(crate::element::ambient::timer(
        std::time::Duration::from_secs(30)
    ));
    poll_fn(|cx| {
        if let Poll::Ready(result) = work.as_mut().poll(cx) {
            return Poll::Ready(result);
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(format!("{operation} timed out")));
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
        HostState::event(
            &self.state,
            WebSocketEvent::Error("WebSocket connection is closed".into()),
        );
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
    error: Option<String>,
    messages: VecDeque<WebSocketData>,
    bytes: usize,
    reading: std::cell::Cell<bool>,
    waker: Option<Waker>,
    close_wakers: Vec<Waker>,
    held: Option<Held>,
    task: std::rc::Weak<RefCell<Option<Box<dyn WebSocketTask>>>>,
}
impl HostState {
    fn event(shared: &Rc<RefCell<Self>>, event: WebSocketEvent) {
        let mut state = shared.borrow_mut();
        if state.error.is_some() {
            return;
        }
        match event {
            WebSocketEvent::Open { .. } => state.open = true,
            WebSocketEvent::Message(message) => {
                if message.len() > LIMIT
                    || state.messages.len() >= UNREAD
                    || state.bytes.saturating_add(message.len()) > LIMIT
                {
                    state.error = Some(format!(
                        "WebSocket closed: more than {UNREAD} messages or {LIMIT} bytes arrived unread"
                    ));
                } else {
                    state.bytes += message.len();
                    state.messages.push_back(message);
                }
            }
            WebSocketEvent::Error(error) => state.error = Some(error),
            WebSocketEvent::Close { .. } => state.error = Some("WebSocket closed by peer".into()),
        }
        let task = if state.error.is_some() {
            state.held.take();
            state.task.upgrade()
        } else {
            None
        };
        let waker = state.waker.take();
        let close_wakers = std::mem::take(&mut state.close_wakers);
        drop(state);
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
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, sync::Arc};

    use super::*;
    use crate::{
        access::Access,
        websocket::{WebSocketEvents, WebSocketTransport},
    };

    thread_local! {
        static EVENTS:RefCell<Option<WebSocketEvents>>=RefCell::new(None);
        static DROPS:Cell<usize>=const {Cell::new(0)};
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
    fn host_checks_grants_headers_and_shared_quota_before_connecting() {
        let mut denied = system();
        denied.access = Arc::new(Access {
            declared: crate::access::Capabilities::default(),
            granted: None,
        });
        assert!(WebSocket::connect("ws://example.com".into(), None, denied).is_err());
        let sys = system();
        let headers = ConnectOptions {
            headers: vec![("x-test".into(), "test".into())],
        };
        assert!(WebSocket::connect("ws://example.com".into(), Some(headers), sys.clone()).is_err());
        let _held = sys
            .quotas
            .reserve(WEBSOCKETS, MAX_WEBSOCKETS, MAX_WEBSOCKETS)
            .unwrap();
        assert!(WebSocket::connect("ws://example.com".into(), None, sys).is_err());
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

    #[tokio::test]
    async fn host_bounds_writes_and_reads_messages_before_close_error() {
        let connection = host(LIMIT);
        assert!(connection.write(Data::Text("x".into())).is_err());
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        HostState::event(
            &host.state,
            WebSocketEvent::Message(WebSocketData::Text("before close".into())),
        );
        HostState::event(
            &host.state,
            WebSocketEvent::Close {
                code: 1000,
                reason: String::new(),
                was_clean: true,
            },
        );
        assert!(connection.read().unwrap().into_future().await.is_ok());
        assert!(connection.read().unwrap().into_future().await.is_err());
    }

    #[test]
    fn host_unread_overflow_cancels_transport_and_outstanding_read_is_exclusive() {
        let connection = host(0);
        let reading = connection.read().unwrap();
        assert!(connection.read().is_err());
        drop(reading);
        let Connection::Host(ref host) = connection.inner else {
            unreachable!()
        };
        for _ in 0..=UNREAD {
            HostState::event(
                &host.state,
                WebSocketEvent::Message(WebSocketData::Bytes(vec![1])),
            );
        }
        assert!(host.task.borrow().is_none());
        assert_eq!(host.state.borrow().messages.len(), UNREAD);
        assert!(
            host.state
                .borrow()
                .error
                .as_ref()
                .unwrap()
                .contains("arrived unread")
        );
    }

    #[tokio::test]
    async fn operations_keep_transport_alive_after_connection_is_collected() {
        let connection = host(0);
        let read = connection.read().unwrap();
        let close = connection.close();
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
        HostState::event(
            &state,
            WebSocketEvent::Close {
                code: 1000,
                reason: String::new(),
                was_clean: true,
            },
        );
        assert!(matches!(poll(read.as_mut()), Poll::Ready(Err(_))));
        assert!(matches!(poll(close.as_mut()), Poll::Ready(Ok(_))));
    }
}
