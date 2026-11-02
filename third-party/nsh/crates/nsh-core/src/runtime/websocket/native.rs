//! `websocket`'s native connections: `connect(url)`, allowed by the HTTP
//! grants a GET of its URL needs
//! ([`crate::access::Access::allows_websocket`]). Calls check their URL,
//! options, grant and limits in the JS call and reject at once (the codes
//! are the parent module's); the handshake is a task of the core, and each
//! connection's socket is driven by a task of its own on the engine's tokio
//! runtime. The task answers pings and keeps what arrives until it is read;
//! while 8 messages or 8 MiB wait unread it does not poll the socket, so
//! TCP's flow control holds the peer back (and pings wait) until the app
//! reads.

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    Message,
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    protocol::{CloseFrame, WebSocketConfig},
};

use super::{
    CloseStatus, ConnectOptions, Data, busy, closed, denied, exceeded, slot, timed_out, too_long,
};
use crate::element::{Held, JsError, Later, Spawned, System, io_code, spawn};

/// The largest message one write sends or one read returns.
const LIMIT: usize = 8 * 1024 * 1024;
/// How long resolving, connecting with the handshake, a write and closing
/// may take.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Unread messages at which the socket is no longer polled.
const UNREAD: usize = 8;
/// Bytes of unread messages at which the socket is no longer polled; with
/// the message that crossed it, less than twice this is kept. Native
/// memory the heap limit does not cover.
const UNREAD_BYTES: usize = LIMIT;
/// Bytes of writes not sent yet, per connection (the global `WebSocket`'s
/// `bufferedAmount` limit); a write past it rejects.
const PENDING_WRITES: usize = LIMIT;
/// The close code of a close frame without one (RFC 6455 7.1.5).
const NO_STATUS: u16 = 1005;

/// WebSocket client connections to the hosts the HTTP grants allow.
pub(super) struct WebSocket;

impl WebSocket {
    /// Connects to a `ws://` or `wss://` URL that capabilities.network allows
    /// a GET of (over `http` / `https`); at most 32 WebSockets per VM.
    pub(super) fn connect(
        url: String,
        options: Option<ConnectOptions>,
        sys: System,
    ) -> Result<impl Future<Output = Result<WebSocketConnection, JsError>>, JsError> {
        let parsed = url::Url::parse(&url)
            .map_err(|error| JsError::Type(format!("invalid WebSocket URL: {error}")))?;
        if !matches!(parsed.scheme(), "ws" | "wss") {
            return Err(JsError::Type(
                "connect(url) expects a ws:// or wss:// URL".into(),
            ));
        }
        // As the global `WebSocket`: the handshake would drop them silently.
        if parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(JsError::Type(
                "connect(url) expects a URL without credentials or fragment".into(),
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
            return Err(denied(parsed.as_str()));
        }
        sys.check_connection(parsed.as_str())?;
        let held = slot(&sys)?;
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

type Reply<T> = oneshot::Sender<Result<T, JsError>>;

enum Command {
    Read(Reply<Option<Message>>),
    Write(Message, Reply<()>),
    Close(CloseStatus, Reply<()>),
}

/// An open WebSocket connection: one read, up to eight commands and 8 MiB
/// of writes may wait at once.
pub(super) struct WebSocketConnection {
    commands: mpsc::Sender<Command>,
    reading: Rc<Cell<bool>>,
    /// Bytes of writes not sent yet.
    pending: Rc<Cell<usize>>,
    /// How the connection closed, once it ended; the driver sets it.
    status: Rc<RefCell<Option<CloseStatus>>>,
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
            return Err(too_long(length));
        }
        let queued = self.pending.get() + length;
        if queued > PENDING_WRITES {
            return Err(exceeded(format!(
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

    /// The next message: a string for text, a Uint8Array for bytes; `null`
    /// once the connection closed cleanly and every message was read.
    pub(super) fn read(&self) -> Result<Later<Option<Data>>, JsError> {
        if self.reading.replace(true) {
            return Err(busy());
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
            Ok::<_, JsError>(message.await?.map(|message| match message {
                Message::Text(text) => Data::Text(text.as_str().to_owned()),
                Message::Binary(bytes) => Data::Bytes(bytes.to_vec()),
                _ => unreachable!("the driver returns data messages only"),
            }))
        }))
    }

    /// Sends a close frame with `frame`'s code and reason and waits for the
    /// peer's reply.
    pub(super) fn close(&self, frame: CloseStatus) -> Later<()> {
        let (send, receive) = oneshot::channel();
        Later::new(enqueue(
            &self.commands,
            Command::Close(frame, send),
            receive,
        ))
    }

    /// How the connection closed, once it did.
    pub(super) fn status(&self) -> Option<CloseStatus> {
        self.status.borrow().clone()
    }
}

/// Queues `command` now (a full queue fails the call's promise) and waits
/// for its reply.
fn enqueue<T: 'static>(
    commands: &mpsc::Sender<Command>,
    command: Command,
    reply: oneshot::Receiver<Result<T, JsError>>,
) -> impl Future<Output = Result<T, JsError>> + 'static {
    let queued = commands.try_send(command).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => exceeded(
            "WebSocket command queue is full; wait for an outstanding operation".to_owned(),
        ),
        mpsc::error::TrySendError::Closed(_) => closed("WebSocket connection is closed"),
    });
    async move {
        queued?;
        reply
            .await
            .map_err(|_| closed("WebSocket connection is closed"))?
    }
}

/// A failure of the socket or the protocol, `context` first in its
/// message: the OS's code for an I/O error (`ERR_SOCKET_CLOSED` for one
/// without), `ERR_SOCKET_CLOSED` for a closed connection, `EMSGSIZE` for a message past the limit, `EPROTO`
/// (and the HTTP `status` of a refused handshake) for the rest.
fn failure(context: &str, error: tokio_tungstenite::tungstenite::Error) -> JsError {
    use tokio_tungstenite::tungstenite::Error as E;
    let message = format!("{context}: {error}");
    match error {
        E::Io(ref io) => match io_code(io) {
            Some(code) => JsError::Error(message).with_code(code),
            None => closed(message),
        },
        E::ConnectionClosed | E::AlreadyClosed => closed(message),
        E::Capacity(_) => JsError::Error(message).with_code("EMSGSIZE"),
        E::WriteBufferFull(_) => exceeded(message),
        E::Http(ref response) => JsError::Error(message)
            .with_code("EPROTO")
            .with("status", response.status().as_u16()),
        _ => JsError::Error(message).with_code("EPROTO"),
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
) -> Result<WebSocketConnection, JsError> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| failure("WebSocket handshake failed", error))?;
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
            .map_err(|_| {
                timed_out(&format!(
                    "WebSocket connection failed: resolving {operation}"
                ))
            })?
            // A failed lookup names no OS error: Node calls it ENOTFOUND.
            .map_err(|error| {
                JsError::Error(format!(
                    "WebSocket connection failed: resolving {operation} failed: {error}"
                ))
                .with_code("ENOTFOUND")
            })?;
    let mut connected = None;
    let mut last_error = None;
    for address in addresses {
        match tokio::time::timeout_at(deadline, tokio::net::TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                connected = Some(stream);
                break;
            }
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => {
                return Err(timed_out(&format!(
                    "WebSocket connection failed: connecting to {operation}"
                )));
            }
        }
    }
    let stream = connected.ok_or_else(|| {
        let message = format!(
            "WebSocket connection failed: connecting to {operation} failed: {}",
            last_error
                .as_ref()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "host resolved to no addresses".into())
        );
        let code = last_error.as_ref().and_then(io_code).unwrap_or("ENOTFOUND");
        JsError::Error(message).with_code(code)
    })?;
    let connector = if url.scheme() == "wss" {
        Some(tokio_tungstenite::Connector::Rustls(
            Arc::new(tls_config()?),
        ))
    } else {
        None
    };
    let (socket, _) = tokio::time::timeout_at(
        deadline,
        tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), connector),
    )
    .await
    .map_err(|_| timed_out("WebSocket handshake"))?
    .map_err(|error| failure("WebSocket handshake failed", error))?;
    let (commands, receiver) = mpsc::channel(UNREAD);
    let status = Rc::<RefCell<Option<CloseStatus>>>::default();
    let driver = spawn(drive(socket, receiver, held, status.clone()));
    Ok(WebSocketConnection {
        commands,
        reading: Rc::default(),
        pending: Rc::default(),
        status,
        _driver: driver,
    })
}

/// Respect the embedding host's provider; otherwise ring is local to this
/// connection. Selecting a fallback must not configure the host's other TLS clients.
fn tls_config() -> Result<rustls::ClientConfig, JsError> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| JsError::Error(format!("WebSocket TLS configuration failed: {error}")))
        .map(|builder| builder.with_root_certificates(roots).with_no_client_auth())
}

/// What a close frame says: its code and reason, 1005 for a frame
/// without a code.
fn received(frame: Option<CloseFrame>) -> CloseStatus {
    frame.map_or(
        CloseStatus {
            code: NO_STATUS,
            reason: String::new(),
        },
        |frame| CloseStatus {
            code: frame.code.into(),
            reason: frame.reason.as_str().to_owned(),
        },
    )
}

/// The close handshake the app starts: its close frame, then the peer's
/// reply, which tells how the connection closed (1006 when the peer ended
/// it without one). What arrives before the reply is dropped: the app
/// reads no more.
async fn handshake(socket: &mut Socket, frame: CloseStatus) -> Result<CloseStatus, JsError> {
    let frame = CloseFrame {
        code: frame.code.into(),
        reason: frame.reason.into(),
    };
    socket
        .close(Some(frame))
        .await
        .map_err(|error| failure("WebSocket close failed", error))?;
    loop {
        match socket.next().await {
            Some(Ok(Message::Close(frame))) => return Ok(received(frame)),
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return Ok(CloseStatus::abnormal()),
        }
    }
}

/// Runs the connection's commands and keeps what arrives until it is read.
/// While [`UNREAD`] messages or [`UNREAD_BYTES`] wait, the socket is not
/// polled: TCP holds the peer back until a read takes one. Once the
/// connection ends, the messages that came before are still read, in
/// order; then a clean close reads `null` and a failure rejects with why it
/// ended. The VM's place for the connection is given back then.
async fn drive(
    mut socket: Socket,
    mut commands: mpsc::Receiver<Command>,
    held: Held,
    status: Rc<RefCell<Option<CloseStatus>>>,
) {
    let mut messages: VecDeque<Message> = VecDeque::new();
    let mut unread = 0;
    let mut read: Option<Reply<Option<Message>>> = None;
    // How it ended, and the error reads reject with (none for a clean close).
    let (ended, error) = loop {
        let room = messages.len() < UNREAD && unread < UNREAD_BYTES;
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                None => {
                    messages.clear();
                    break (CloseStatus::abnormal(), Some(closed("WebSocket connection is closed")));
                }
                Some(Command::Read(reply)) => match messages.pop_front() {
                    Some(message) => {
                        unread -= message.len();
                        let _ = reply.send(Ok(Some(message)));
                    }
                    None => read = Some(reply),
                },
                Some(Command::Write(message, reply)) => {
                    let result = tokio::time::timeout(TIMEOUT, socket.send(message))
                        .await
                        .map_err(|_| timed_out("WebSocket write"))
                        .and_then(|result| result.map_err(|error| failure("WebSocket write failed", error)));
                    let failure = result.as_ref().err().cloned();
                    let _ = reply.send(result);
                    if let Some(error) = failure {
                        break (CloseStatus::abnormal(), Some(error));
                    }
                }
                Some(Command::Close(frame, reply)) => {
                    // Closed by the app: what was not read goes with it.
                    messages.clear();
                    let result = tokio::time::timeout(TIMEOUT, handshake(&mut socket, frame))
                        .await
                        .map_err(|_| timed_out("WebSocket close"))
                        .and_then(|result| result);
                    let ended = result.as_ref().map_or_else(|_| CloseStatus::abnormal(), Clone::clone);
                    // Set before the reply: `closeCode` is there once
                    // `close()` resolves.
                    *status.borrow_mut() = Some(ended.clone());
                    let _ = reply.send(result.map(drop));
                    break (ended, None);
                }
            },
            incoming = socket.next(), if room => match incoming {
                Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                    if let Some(reply) = read.take() {
                        let _ = reply.send(Ok(Some(message)));
                    } else {
                        unread += message.len();
                        messages.push_back(message);
                    }
                }
                Some(Ok(Message::Ping(_))) => {
                    if let Err(error) = socket.flush().await {
                        break (CloseStatus::abnormal(), Some(failure("WebSocket pong failed", error)));
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    // Sends the reply tungstenite queued.
                    let _ = socket.flush().await;
                    break (received(frame), None);
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => break (CloseStatus::abnormal(), Some(failure("WebSocket read failed", error))),
                None => break (
                    CloseStatus::abnormal(),
                    Some(closed("WebSocket connection ended without a close handshake")),
                ),
            }
        }
    };
    *status.borrow_mut() = Some(ended);
    let next = |messages: &mut VecDeque<Message>| match messages.pop_front() {
        Some(message) => Ok(Some(message)),
        None => error.clone().map_or(Ok(None), Err),
    };
    if let Some(reply) = read {
        let _ = reply.send(next(&mut messages));
    }
    drop(socket);
    drop(held);
    while let Some(command) = commands.recv().await {
        match command {
            Command::Read(reply) => {
                let _ = reply.send(next(&mut messages));
            }
            Command::Write(_, reply) => {
                let _ = reply.send(Err(closed("WebSocket connection is closed")));
            }
            Command::Close(_, reply) => {
                messages.clear();
                let _ = reply.send(Ok(()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Access;

    #[test]
    fn tls_provider_is_scoped_to_the_connection() {
        // The default provider is a process-wide OnceLock. Exercise both its
        // empty and installed states in a fresh process, apart from other tests.
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime::websocket::native::tests::tls_provider_in_fresh_process",
                "--ignored",
                "--nocapture",
            ])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[tokio::test]
    #[ignore = "run by tls_provider_is_scoped_to_the_connection in a fresh process"]
    async fn tls_provider_in_fresh_process() {
        use rustls::crypto::CryptoProvider;
        assert!(CryptoProvider::get_default().is_none());
        for scheme in ["ws", "wss"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let peer = std::thread::spawn(move || {
                drop(listener.accept().unwrap());
            });
            let sys = System {
                access: Arc::new(Access::all()),
                ..System::default()
            };
            let result = WebSocket::connect(format!("{scheme}://127.0.0.1:{port}"), None, sys)
                .unwrap()
                .await;
            assert!(
                matches!(result, Err(ref error) if error.message().contains("WebSocket handshake failed"))
            );
            peer.join().unwrap();
            assert!(
                CryptoProvider::get_default().is_none(),
                "{scheme} selected the host's provider"
            );
        }
        let mut host = rustls::crypto::ring::default_provider();
        host.cipher_suites.truncate(1);
        host.install_default().unwrap();
        let host = CryptoProvider::get_default().unwrap();
        let config = tls_config().unwrap();
        assert!(Arc::ptr_eq(config.crypto_provider(), host));
    }
}
