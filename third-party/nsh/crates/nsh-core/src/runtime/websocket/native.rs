//! `websocket`: an explicit WebSocket client (`WebSocket.connect(url)`),
//! allowed by the HTTP grants a GET of its URL needs
//! ([`crate::access::Access::allows_websocket`]). Calls check their URL,
//! options, grant and limits in the JS call (a `TypeError` or `RangeError`
//! there); the handshake is a task of the core, and each connection's
//! socket is driven by a task of its own on the engine's tokio runtime,
//! which answers pings and keeps up to eight unread messages.

use std::{cell::Cell, collections::VecDeque, rc::Rc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    Message,
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    protocol::WebSocketConfig,
};

use super::{
    super::{MAX_WEBSOCKETS, WEBSOCKETS},
    ConnectOptions, Data,
};
use crate::element::{
    Held, JsError, Later, System,
    ambient::{Spawned, spawn},
};

/// The largest message one write sends or one read returns.
const LIMIT: usize = 8 * 1024 * 1024;
/// How long resolving, connecting with the handshake, a write and closing
/// may take.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Messages received while no read waits; one more closes the connection.
const UNREAD: usize = 8;
/// Bytes of messages received while no read waits; more closes the
/// connection. Native memory the heap limit does not cover.
const UNREAD_BYTES: usize = LIMIT;
/// Bytes of writes not sent yet, per connection (the global `WebSocket`'s
/// `bufferedAmount` limit); a write past it throws.
const PENDING_WRITES: usize = LIMIT;

/// WebSocket client connections to the hosts the HTTP grants allow (native
/// hosts only: on the web, importing this module throws).
pub(super) struct WebSocket;

impl WebSocket {
    /// Connects to a `ws://` or `wss://` URL that capabilities.network allows
    /// a GET of (over `http` / `https`); at most 32 WebSockets per VM.
    pub(super) fn connect(
        url: String,
        options: Option<ConnectOptions>,
        sys: System,
    ) -> Result<impl Future<Output = Result<WebSocketConnection, String>>, JsError> {
        let parsed = url::Url::parse(&url)
            .map_err(|error| JsError::Type(format!("invalid WebSocket URL: {error}")))?;
        if !matches!(parsed.scheme(), "ws" | "wss") {
            return Err(JsError::Type(
                "WebSocket.connect(url) expects a ws:// or wss:// URL".into(),
            ));
        }
        // As the global `WebSocket`: the handshake would drop them silently.
        if parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(JsError::Type(
                "WebSocket.connect(url) expects a URL without credentials or fragment".into(),
            ));
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| JsError::Type("WebSocket URL has no host".into()))?
            .to_owned();
        let port = parsed.port_or_known_default().ok_or_else(|| {
            JsError::Type("WebSocket URL has no port and no known default".into())
        })?;
        // Checked on the parsed URL, which is the one the handshake uses.
        if !sys.access.allows_websocket(parsed.as_str()) {
            return Err(JsError::Type(format!(
                "network access to `{host}` is not granted; add it to capabilities.network.hosts or a GET rule in capabilities.network.http"
            )));
        }
        let held = sys.quotas.take(WEBSOCKETS, MAX_WEBSOCKETS).ok_or_else(|| {
            JsError::Range(format!(
                "At most {MAX_WEBSOCKETS} concurrent WebSockets are allowed per VM"
            ))
        })?;
        let headers = options
            .map(|o| o.headers)
            .unwrap_or_default()
            .into_iter()
            .map(|(name, value)| {
                Ok((
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|e| JsError::Type(e.to_string()))?,
                    HeaderValue::from_str(&value).map_err(|e| JsError::Type(e.to_string()))?,
                ))
            })
            .collect::<Result<Vec<_>, JsError>>()?;
        Ok(open(parsed, host, port, headers, held))
    }
}

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Command {
    Read(Reply<Message>),
    Write(Message, Reply<()>),
    Close(Reply<()>),
}

/// An open WebSocket connection: one read, up to eight commands and 8 MiB
/// of writes may wait at once.
pub(super) struct WebSocketConnection {
    commands: mpsc::Sender<Command>,
    reading: Rc<Cell<bool>>,
    /// Bytes of writes not sent yet.
    pending: Rc<Cell<usize>>,
    /// The task driving the socket; dropping it closes the connection.
    _driver: Spawned<()>,
}

impl WebSocketConnection {
    /// Sends a text (string) or binary (Uint8Array) message of at most
    /// 8 MiB; at most 8 MiB of writes may wait to be sent.
    pub(super) fn write(&self, data: Data) -> Result<Later<()>, JsError> {
        let message = match data {
            Data::Text(text) => Message::Text(text.into()),
            Data::Bytes(bytes) => Message::Binary(bytes.into()),
        };
        let length = message.len();
        if length > LIMIT {
            return Err(JsError::Range(format!(
                "WebSocket write exceeded the {LIMIT} byte limit"
            )));
        }
        let queued = self.pending.get() + length;
        if queued > PENDING_WRITES {
            return Err(JsError::Range(format!(
                "WebSocket writes waiting to be sent exceeded the {PENDING_WRITES} byte limit"
            )));
        }
        self.pending.set(queued);
        struct Pending(Rc<Cell<usize>>, usize);
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.set(self.0.get() - self.1);
            }
        }
        let pending = Pending(self.pending.clone(), length);
        let (send, receive) = oneshot::channel();
        let sent = enqueue(&self.commands, Command::Write(message, send), receive);
        Ok(Later::new(async move {
            let _pending = pending;
            sent.await
        }))
    }

    /// The next message: a string for text, a Uint8Array for bytes.
    pub(super) fn read(&self) -> Result<Later<Data>, JsError> {
        if self.reading.replace(true) {
            return Err(JsError::Type(
                "WebSocket.read() already has an outstanding read".into(),
            ));
        }
        struct Reading(Rc<Cell<bool>>);
        impl Drop for Reading {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }
        let reading = Reading(self.reading.clone());
        let (send, receive) = oneshot::channel();
        let message = enqueue(&self.commands, Command::Read(send), receive);
        Ok(Later::new(async move {
            let _reading = reading;
            Ok::<_, String>(match message.await? {
                Message::Text(text) => Data::Text(text.as_str().to_owned()),
                Message::Binary(bytes) => Data::Bytes(bytes.to_vec()),
                _ => unreachable!("the driver returns data messages only"),
            })
        }))
    }

    /// Sends a close frame and ends the connection.
    pub(super) fn close(&self) -> Later<()> {
        let (send, receive) = oneshot::channel();
        Later::new(enqueue(&self.commands, Command::Close(send), receive))
    }
}

/// Queues `command` now (a full queue fails the call's promise) and waits
/// for its reply.
fn enqueue<T: 'static>(
    commands: &mpsc::Sender<Command>,
    command: Command,
    reply: oneshot::Receiver<Result<T, String>>,
) -> impl Future<Output = Result<T, String>> + 'static {
    let queued = commands.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => {
            "WebSocket command queue is full; wait for an outstanding operation".to_owned()
        }
        mpsc::error::TrySendError::Closed(_) => "WebSocket connection is closed".to_owned(),
    });
    async move {
        queued?;
        reply
            .await
            .map_err(|_| "WebSocket connection is closed".to_owned())?
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Resolves, connects and shakes hands within [`TIMEOUT`].
async fn open(
    url: url::Url,
    host: String,
    port: u16,
    headers: Vec<(HeaderName, HeaderValue)>,
    held: Held,
) -> Result<WebSocketConnection, String> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("WebSocket handshake failed: {error}"))?;
    request.headers_mut().extend(headers);
    request
        .headers_mut()
        .entry("User-Agent")
        .or_insert(HeaderValue::from_static(concat!(
            "nsh/",
            env!("CARGO_PKG_VERSION")
        )));
    let config = WebSocketConfig::default()
        .max_message_size(Some(LIMIT))
        .max_frame_size(Some(LIMIT));
    let operation = format!("WebSocket host {host}:{port}");
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    let addresses =
        tokio::time::timeout_at(deadline, tokio::net::lookup_host((host.as_str(), port)))
            .await
            .map_err(|_| format!("WebSocket connection failed: resolving {operation} timed out"))?
            .map_err(|error| {
                format!("WebSocket connection failed: resolving {operation} failed: {error}")
            })?;
    let mut connected = None;
    let mut last_error = "host resolved to no addresses".to_owned();
    for address in addresses {
        match tokio::time::timeout_at(deadline, tokio::net::TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                connected = Some(stream);
                break;
            }
            Ok(Err(error)) => last_error = error.to_string(),
            Err(_) => {
                return Err(format!(
                    "WebSocket connection failed: connecting to {operation} timed out"
                ));
            }
        }
    }
    let stream = connected.ok_or_else(|| {
        format!("WebSocket connection failed: connecting to {operation} failed: {last_error}")
    })?;
    let (socket, _) = tokio::time::timeout_at(
        deadline,
        tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), None),
    )
    .await
    .map_err(|_| "WebSocket handshake timed out".to_owned())?
    .map_err(|error| format!("WebSocket handshake failed: {error}"))?;
    let (commands, receiver) = mpsc::channel(UNREAD);
    let driver = spawn(drive(socket, receiver, held));
    Ok(WebSocketConnection {
        commands,
        reading: Rc::default(),
        pending: Rc::default(),
        _driver: driver,
    })
}

/// Runs the connection's commands and keeps what arrives until it is read.
/// Once the peer ends the connection, the messages that came before are
/// still read, in order, before the reason it ended; the VM's place for
/// the connection is given back then.
async fn drive(mut socket: Socket, mut commands: mpsc::Receiver<Command>, held: Held) {
    let mut messages: VecDeque<Message> = VecDeque::new();
    let mut unread = 0;
    let mut read: Option<Reply<Message>> = None;
    let error = loop {
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                None => {
                    messages.clear();
                    break "WebSocket connection is closed".to_owned();
                }
                Some(Command::Read(reply)) => match messages.pop_front() {
                    Some(message) => {
                        unread -= message.len();
                        let _ = reply.send(Ok(message));
                    }
                    None => read = Some(reply),
                },
                Some(Command::Write(message, reply)) => {
                    let result = tokio::time::timeout(TIMEOUT, socket.send(message))
                        .await
                        .map_err(|_| "WebSocket write timed out".to_owned())
                        .and_then(|result| result.map_err(|error| format!("WebSocket write failed: {error}")));
                    let failure = result.as_ref().err().cloned();
                    let _ = reply.send(result);
                    if let Some(error) = failure {
                        break error;
                    }
                }
                Some(Command::Close(reply)) => {
                    let result = tokio::time::timeout(TIMEOUT, socket.close(None))
                        .await
                        .map_err(|_| "WebSocket close timed out".to_owned())
                        .and_then(|result| result.map_err(|error| format!("WebSocket close failed: {error}")));
                    let _ = reply.send(result);
                    // Closed by the app: what was not read goes with it.
                    messages.clear();
                    break "WebSocket connection is closed".to_owned();
                }
            },
            incoming = socket.next() => match incoming {
                Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                    if let Some(reply) = read.take() {
                        let _ = reply.send(Ok(message));
                    } else if messages.len() < UNREAD && unread + message.len() <= UNREAD_BYTES {
                        unread += message.len();
                        messages.push_back(message);
                    } else {
                        // The app reads slower than the peer sends: closing
                        // bounds the memory instead of buffering without end.
                        let _ = tokio::time::timeout(TIMEOUT, socket.close(None)).await;
                        break format!(
                            "WebSocket closed: more than {UNREAD} messages or {UNREAD_BYTES} bytes arrived unread"
                        );
                    }
                }
                Some(Ok(Message::Ping(_))) => {
                    if let Err(error) = socket.flush().await {
                        break format!("WebSocket pong failed: {error}");
                    }
                }
                Some(Ok(Message::Close(_))) => {
                    let _ = socket.flush().await;
                    break "WebSocket closed by peer".to_owned();
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => break format!("WebSocket read failed: {error}"),
                None => break "WebSocket connection is closed".to_owned(),
            }
        }
    };
    if let Some(reply) = read {
        let _ = reply.send(Err(error.clone()));
    }
    drop(socket);
    drop(held);
    while let Some(command) = commands.recv().await {
        match command {
            Command::Read(reply) => {
                let _ = reply.send(messages.pop_front().ok_or_else(|| error.clone()));
            }
            Command::Write(_, reply) => {
                let _ = reply.send(Err("WebSocket connection is closed".to_owned()));
            }
            Command::Close(reply) => {
                messages.clear();
                let _ = reply.send(Ok(()));
            }
        }
    }
}
