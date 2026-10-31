//! The host transport shared by the two WebSocket APIs. Rust checks the
//! URL, capabilities and quotas before asking the platform to connect.
//! Each task belongs to its calling engine; dropping it cancels the socket
//! and prevents further events. Browser implementations use the page's
//! WebSocket API without changing the app's JavaScript classes. The
//! `websocket` module pauses a task while the app's unread messages fill
//! their queue ([`WebSocketTask::pause`]) and resumes it as the app reads.

/// A text or binary WebSocket message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebSocketData {
    /// UTF-8 text.
    Text(String),
    /// Binary bytes.
    Bytes(Vec<u8>),
}

impl WebSocketData {
    /// The message's byte length.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Bytes(bytes) => bytes.len(),
        }
    }

    /// Whether the message has no bytes.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A handshake already checked against the app's capabilities.
#[derive(Clone, Debug)]
pub struct WebSocketRequest {
    /// A normalized absolute ws/wss URL.
    pub url: String,
    /// Requested subprotocols, in preference order.
    pub protocols: Vec<String>,
    /// Additional validated headers; browsers only support an empty list.
    pub headers: Vec<(String, String)>,
}

/// An event from one host socket.
#[derive(Clone, Debug)]
pub enum WebSocketEvent {
    /// The handshake succeeded.
    Open {
        /// The negotiated subprotocol, or an empty string.
        protocol: String,
    },
    /// A complete text or binary message.
    Message(WebSocketData),
    /// A transport failure. A close event may follow it.
    Error(String),
    /// The connection ended.
    Close {
        /// The peer's close code, or 1006 for an abnormal end.
        code: u16,
        /// The peer's reason.
        reason: String,
        /// Whether the close handshake completed.
        was_clean: bool,
    },
}

/// Engine-local events. A transport delivers them on its engine's thread,
/// after `connect` returns, and never while a task method is being called.
pub type WebSocketEvents = Box<dyn FnMut(WebSocketEvent)>;

/// One host socket. Dropping it cancels I/O and unregisters its events.
pub trait WebSocketTask: 'static {
    /// Queues a complete message; the caller has checked its size.
    fn send(&mut self, data: WebSocketData) -> Result<(), String>;
    /// Begins a close handshake with the given code and reason.
    fn close(&mut self, code: u16, reason: &str) -> Result<(), String>;
    /// Bytes the host still has queued for sending.
    fn buffered_amount(&self) -> usize;
    /// Stops (`true`) or resumes (`false`) delivering messages: the app's
    /// unread messages fill their queue (back pressure). A transport that
    /// can stop reading from the network does, so the peer is held back;
    /// one that cannot keeps the messages until it resumes. Messages already
    /// on their way may still arrive; the caller bounds what it keeps.
    fn pause(&mut self, paused: bool);
}

/// A platform's WebSocket stack. The factory is shareable, while each
/// socket and its callbacks stay on their owning engine's thread.
pub trait WebSocketTransport: Send + Sync + 'static {
    /// Whether additional handshake headers can be supplied.
    fn supports_headers(&self) -> bool {
        true
    }
    /// Starts a handshake. Events arrive after this method returns.
    fn connect(
        &self,
        request: WebSocketRequest,
        events: WebSocketEvents,
    ) -> Result<Box<dyn WebSocketTask>, String>;
}
