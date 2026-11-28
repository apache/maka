//! `nsh test --attach`'s side of [`ATTACH_PATH`]: a connection to the dev
//! server of a development session that is already running, through which
//! its hosts take test steps.

use std::{
    io::ErrorKind,
    net::{SocketAddr, TcpStream},
    sync::Mutex,
    time::{Duration, Instant},
};

use tungstenite::{Message, WebSocket, protocol::WebSocketConfig, stream::MaybeTlsStream};

use crate::protocol::{
    ATTACH_PATH, AttachHost, AttachReply, AttachRequest, MAX_MESSAGE_SIZE, PROTOCOL_VERSION,
    StepOutcome, TestStep,
};

/// How long the server may take to answer the hello.
const HELLO: Duration = Duration::from_secs(5);
/// What a step's outcome may take beyond the step's own timeout: the round
/// trip through the server.
const ROUND_TRIP: Duration = Duration::from_secs(5);

/// A connection to a development session's dev server that drives its hosts
/// (`nsh test --attach`). Dropping it leaves the hosts and their apps as
/// they run.
pub struct Attachment {
    socket: Mutex<Socket>,
}

struct Socket {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next: u64,
}

impl Attachment {
    /// Connects to the dev server at `addr` (on this machine) with the
    /// session's `token`: the connection, and the hosts connected now,
    /// oldest first. Fails with the server's reason when it refuses.
    pub fn connect(addr: SocketAddr, token: &str) -> Result<(Attachment, Vec<AttachHost>), String> {
        let url = format!("ws://{addr}{ATTACH_PATH}");
        // Screenshots come back inside one message.
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_SIZE))
            .max_frame_size(Some(MAX_MESSAGE_SIZE));
        let stream = TcpStream::connect_timeout(&addr, HELLO)
            .map_err(|e| format!("cannot reach the dev server at {addr}: {e}"))?;
        let _ = stream.set_nodelay(true);
        let (socket, _) = tungstenite::client::client_with_config(
            url,
            MaybeTlsStream::Plain(stream),
            Some(config),
        )
        .map_err(|e| format!("the dev server at {addr} refused: {e}"))?;
        let mut socket = Socket { socket, next: 1 };
        socket.send(&AttachRequest::Hello {
            protocol: PROTOCOL_VERSION,
            token: token.to_owned(),
        })?;
        match socket.read(Instant::now() + HELLO)? {
            AttachReply::Hosts { hosts } => Ok((
                Attachment {
                    socket: Mutex::new(socket),
                },
                hosts,
            )),
            AttachReply::Refused { message } => Err(message),
            AttachReply::StepDone { .. } => Err("the dev server answered oddly".into()),
        }
    }

    /// Asks host `host` ([`AttachHost::id`]) to take `step`, waiting
    /// `timeout` at most: what a query gives (`null` for actions), or why it
    /// failed.
    pub fn step(
        &self,
        host: u64,
        step: TestStep,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let mut socket = self.socket.lock().unwrap_or_else(|e| e.into_inner());
        let id = socket.next;
        socket.next += 1;
        socket.send(&AttachRequest::Step {
            id,
            host,
            step,
            timeout_ms: timeout.as_millis().min(u128::from(u64::MAX)) as u64,
        })?;
        let deadline = Instant::now() + timeout + ROUND_TRIP;
        loop {
            match socket.read(deadline)? {
                AttachReply::StepDone { id: done, outcome } if done == id => {
                    return match outcome {
                        StepOutcome::Done { value } => Ok(value),
                        StepOutcome::Failed { message } => Err(message),
                    };
                }
                AttachReply::Refused { message } => return Err(message),
                // An earlier step's, which its caller gave up on.
                _ => {}
            }
        }
    }
}

impl Socket {
    fn send(&mut self, request: &AttachRequest) -> Result<(), String> {
        let text = serde_json::to_string(request).map_err(|e| e.to_string())?;
        self.socket
            .send(Message::Text(text.into()))
            .map_err(|e| format!("the dev server's connection ended: {e}"))
    }

    /// The server's next message, by `deadline`.
    fn read(&mut self, deadline: Instant) -> Result<AttachReply, String> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("the dev server did not answer in time".into());
            }
            if let MaybeTlsStream::Plain(stream) = self.socket.get_mut() {
                let _ = stream.set_read_timeout(Some(left));
            }
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    return serde_json::from_str(&text)
                        .map_err(|e| format!("the dev server sent an invalid message: {e}"));
                }
                Ok(Message::Close(_)) => return Err("the dev server closed the connection".into()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(err))
                    if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(err) => return Err(format!("the dev server's connection ended: {err}")),
            }
        }
    }
}
