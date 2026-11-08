use std::{
    io::ErrorKind,
    net::TcpStream,
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError},
    thread,
    time::Duration,
};

use tungstenite::{Message, WebSocket, stream::MaybeTlsStream};

use crate::protocol::{
    BundleFormat, ClientMessage, HostPlatform, LogLevel, PROTOCOL_VERSION, ServerMessage,
    StepOutcome, TestStep,
};

/// Something the dev server told the host.
#[derive(Debug)]
pub enum DevEvent {
    /// Connected (or reconnected) to the server.
    Connected,
    /// Lost the connection; the client keeps retrying.
    Disconnected,
    /// The server runs a test session: keep the model of the app test
    /// steps need, from the first bundle on. Comes before the bundle.
    Testing,
    /// A step of the test: answer it with [`DevClient::step_done`] and its
    /// id.
    Step {
        /// Its id.
        id: u64,
        /// What to do.
        step: TestStep,
    },
    /// What a test session's app starts with
    /// ([`crate::protocol::ServerMessage::TestSetup`]): the storage it
    /// finds. Its requests go to the test ([`DevClient::fetch`]).
    TestSetup {
        /// The storage's entries.
        storage: Vec<(String, String)>,
        /// Trace the app: log each commit's timings and send each batch
        /// ([`DevClient::trace`]).
        trace: bool,
        /// What the test fixes of the app's environment, and its clipboard.
        environment: crate::protocol::TestEnvironment,
    },
    /// The test's answer to request `id` ([`DevClient::fetch`]): one
    /// event of it.
    Fetch {
        /// The request's id.
        id: u64,
        /// The event.
        reply: crate::protocol::FetchReply,
    },
    /// Run the host's own Rust root (see [`crate::protocol::ServerMessage::Root`]).
    Root,
    /// A rebuild started.
    Building,
    /// The build failed.
    BuildFailed(String),
    /// The host cannot run the app (see [`ServerMessage::CannotRun`]): no
    /// bundle comes until one needs only the UI sets it serves.
    CannotRun {
        /// The UI sets the app imports that the host does not serve.
        missing: Vec<String>,
        /// What to show the developer.
        message: String,
    },
    /// A hot update for hosts running bundle `base` (see
    /// [`ServerMessage::Patch`]); the bundle of `version` follows.
    Patch {
        /// The server run the build numbers are of
        /// ([`ServerMessage::Hello`]).
        session: u64,
        /// Build number after the update.
        version: u64,
        /// Build number the update applies to.
        base: u64,
        /// The update script.
        code: String,
        /// Its source map (JSON).
        source_map: Option<String>,
    },
    /// A new bundle.
    Bundle {
        /// The server run the build number is of.
        session: u64,
        /// Build number.
        version: u64,
        /// Payload format.
        format: BundleFormat,
        /// Payload.
        bytes: Vec<u8>,
        /// Source map (JSON), when the server has one.
        source_map: Option<String>,
        /// What the app declares it may reach (JSON), if it declares it.
        capabilities: Option<String>,
        /// The app's id (`nsh.json` `"id"`): give it to the bundle
        /// (`Bundle::with_app_id`), as it names where the app keeps its data.
        app_id: Option<String>,
        /// The main window's launch-time options (`nsh.json` `"window"`,
        /// JSON): give them to the bundle (`Bundle::with_main_window`).
        window: Option<String>,
        /// The VM limits to run it with (`nsh run --limits`, see
        /// [`ServerMessage::Bundle`]): `nsh_core::js::Limits::development`
        /// reads them; `None` is none.
        limits: Option<String>,
    },
}

/// What a host tells the dev server about itself.
#[derive(Debug, Clone)]
pub struct HostInfo {
    /// Human-readable device name, shown in the developer's terminal.
    pub device: String,
    /// What kind of host it is.
    pub platform: HostPlatform,
    /// The bytecode format its engine loads (`BYTECODE_VERSION`).
    pub bytecode_version: String,
    /// The specifiers of the UI sets it serves (an app's
    /// own): the server sends no bundle that imports others.
    pub ui_sets: Vec<String>,
    /// It takes test steps ([`DevEvent::Step`]).
    pub tests: bool,
}

/// Connects a dev host to a dev server, reconnecting until dropped, and
/// forwards log lines to it.
pub struct DevClient {
    logs: SyncSender<ClientMessage>,
    /// Steps' outcomes, which are never dropped.
    replies: mpsc::Sender<ClientMessage>,
}

/// How long a read may block before pending log lines are flushed.
const POLL: Duration = Duration::from_millis(15);
/// Log lines queued while the socket is busy or down; older ones are dropped.
const LOG_QUEUE: usize = 1024;

impl DevClient {
    /// Starts the client thread. `on_event` runs on that thread.
    pub fn start(
        url: String,
        host: HostInfo,
        mut on_event: impl FnMut(DevEvent) + Send + 'static,
    ) -> std::io::Result<DevClient> {
        let (logs, log_rx) = mpsc::sync_channel(LOG_QUEUE);
        let (replies, reply_rx) = mpsc::channel();
        let hello = ClientMessage::Hello {
            protocol: PROTOCOL_VERSION,
            bytecode_version: host.bytecode_version,
            device: host.device,
            platform: Some(host.platform),
            ui_sets: Some(host.ui_sets),
            tests: host.tests,
        };
        thread::Builder::new()
            .name("nsh-dev-client".into())
            .spawn(move || {
                let mut backoff = Duration::from_millis(100);
                loop {
                    // Dropped while disconnected: stop retrying.
                    if let Err(TryRecvError::Disconnected) = log_rx.try_recv() {
                        return;
                    }
                    match tungstenite::connect(url.as_str()) {
                        Ok((socket, _)) => {
                            backoff = Duration::from_millis(100);
                            on_event(DevEvent::Connected);
                            if let Err(SessionEnd::Shutdown) =
                                session(socket, &hello, &log_rx, &reply_rx, &mut on_event)
                            {
                                return;
                            }
                            on_event(DevEvent::Disconnected);
                        }
                        Err(_) => backoff = (backoff * 2).min(Duration::from_secs(2)),
                    }
                    thread::sleep(backoff);
                }
            })?;
        Ok(DevClient { logs, replies })
    }

    /// Forwards the app's request `id` to the test, which answers with
    /// [`DevEvent::Fetch`]es of that id (a test session's).
    pub fn fetch(&self, id: u64, request: crate::protocol::WireRequest) {
        let _ = self.replies.send(ClientMessage::Fetch { id, request });
    }

    /// The app no longer wants the answer to request `id`.
    pub fn fetch_cancel(&self, id: u64) {
        let _ = self.replies.send(ClientMessage::FetchCancel { id });
    }

    /// Sends the mount items of a batch the traced app applied, a line
    /// each ([`DevEvent::TestSetup`]), in order with the steps' outcomes.
    pub fn trace(&self, items: Vec<String>) {
        let _ = self.replies.send(ClientMessage::Trace { items });
    }

    /// Sends the outcome of the step `id` ([`DevEvent::Step`]).
    pub fn step_done(&self, id: u64, outcome: StepOutcome) {
        let _ = self.replies.send(ClientMessage::StepDone { id, outcome });
    }

    /// Queues a log line for the server. Never blocks; drops on overflow.
    pub fn log(&self, level: LogLevel, target: &str, message: &str) {
        let _ = self.logs.try_send(ClientMessage::Log {
            level,
            target: target.to_owned(),
            message: message.to_owned(),
        });
    }
}

enum SessionEnd {
    Disconnected,
    /// The `DevClient` was dropped.
    Shutdown,
}

fn session(
    mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
    hello: &ClientMessage,
    logs: &Receiver<ClientMessage>,
    replies: &Receiver<ClientMessage>,
    on_event: &mut impl FnMut(DevEvent),
) -> Result<(), SessionEnd> {
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(Some(POLL));
        let _ = stream.set_nodelay(true);
    }
    send(&mut socket, hello)?;
    /// A bundle or patch announced by a text frame, waiting for its binary
    /// frames.
    struct Pending {
        version: u64,
        /// `Some(base)` for a patch.
        base: Option<u64>,
        format: BundleFormat,
        source_map: bool,
        capabilities: Option<String>,
        app_id: Option<String>,
        window: Option<String>,
        limits: Option<String>,
        bytes: Option<Vec<u8>>,
    }
    let mut pending: Option<Pending> = None;
    let mut server_session = 0;
    loop {
        loop {
            match logs.try_recv() {
                Ok(msg) => send(&mut socket, &msg)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Err(SessionEnd::Shutdown),
            }
        }
        while let Ok(msg) = replies.try_recv() {
            send(&mut socket, &msg)?;
        }
        let msg = match socket.read() {
            Ok(msg) => msg,
            Err(tungstenite::Error::Io(err))
                if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                continue;
            }
            Err(_) => return Err(SessionEnd::Disconnected),
        };
        match msg {
            Message::Text(text) => match serde_json::from_str::<ServerMessage>(&text) {
                Ok(ServerMessage::Hello { session, test, .. }) => {
                    server_session = session;
                    if test {
                        on_event(DevEvent::Testing);
                    }
                }
                Ok(ServerMessage::Step { id, step }) => on_event(DevEvent::Step { id, step }),
                Ok(ServerMessage::TestSetup {
                    storage,
                    trace,
                    environment,
                }) => on_event(DevEvent::TestSetup {
                    storage,
                    trace,
                    environment,
                }),
                Ok(ServerMessage::Fetch { id, reply }) => on_event(DevEvent::Fetch { id, reply }),
                Ok(ServerMessage::Root) => on_event(DevEvent::Root),
                Ok(ServerMessage::Building) => on_event(DevEvent::Building),
                Ok(ServerMessage::BuildFailed { message }) => {
                    on_event(DevEvent::BuildFailed(message))
                }
                Ok(ServerMessage::CannotRun { missing, message }) => {
                    on_event(DevEvent::CannotRun { missing, message })
                }
                Ok(ServerMessage::Bundle {
                    version,
                    format,
                    source_map,
                    capabilities,
                    app_id,
                    window,
                    limits,
                }) => {
                    pending = Some(Pending {
                        version,
                        base: None,
                        format,
                        source_map,
                        capabilities,
                        app_id,
                        window,
                        limits,
                        bytes: None,
                    })
                }
                Ok(ServerMessage::Patch {
                    version,
                    base,
                    source_map,
                }) => {
                    pending = Some(Pending {
                        version,
                        base: Some(base),
                        format: BundleFormat::Source,
                        source_map,
                        capabilities: None,
                        app_id: None,
                        window: None,
                        limits: None,
                        bytes: None,
                    })
                }
                Err(err) => log::warn!("dev server sent an invalid message: {err}"),
            },
            Message::Binary(frame) => {
                let Some(mut p) = pending.take() else {
                    continue;
                };
                let (bytes, source_map) = match p.bytes.take() {
                    // Payload first; wait for the map if one was announced.
                    None if p.source_map => {
                        p.bytes = Some(frame.to_vec());
                        pending = Some(p);
                        continue;
                    }
                    None => (frame.to_vec(), None),
                    Some(bytes) => (bytes, String::from_utf8(frame.to_vec()).ok()),
                };
                match p.base {
                    Some(base) => match String::from_utf8(bytes) {
                        Ok(code) => on_event(DevEvent::Patch {
                            session: server_session,
                            version: p.version,
                            base,
                            code,
                            source_map,
                        }),
                        Err(_) => log::warn!("dev server sent a non-UTF-8 patch"),
                    },
                    None => on_event(DevEvent::Bundle {
                        session: server_session,
                        version: p.version,
                        format: p.format,
                        bytes,
                        source_map,
                        capabilities: p.capabilities,
                        app_id: p.app_id,
                        window: p.window,
                        limits: p.limits,
                    }),
                }
            }
            Message::Close(_) => return Err(SessionEnd::Disconnected),
            _ => {}
        }
    }
}

fn send(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    msg: &ClientMessage,
) -> Result<(), SessionEnd> {
    let text = serde_json::to_string(msg).expect("serializable");
    socket
        .send(Message::Text(text.into()))
        .map_err(|_| SessionEnd::Disconnected)
}
