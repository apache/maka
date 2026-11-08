use std::{
    io,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tokio::sync::broadcast;

use crate::protocol::{
    BundleFormat, ClientMessage, FetchReply, HostPlatform, LogLevel, PROTOCOL_VERSION,
    ServerMessage, StepOutcome, TestNetwork, TestStep, WS_PATH,
};

/// What a dev host did, for the server's owner to show ([`DevServer::start`]).
#[derive(Debug, Clone)]
pub enum ClientEvent {
    /// A host connected.
    Connected {
        /// Device name from the client's hello.
        device: String,
        /// The build it was sent first: the latest bundle (`None`: none
        /// yet, or the latest build failed).
        build: Option<u64>,
    },
    /// A host cannot run the app: the latest bundle imports UI sets it
    /// does not serve (it was built for another app). It gets no bundle
    /// until one needs only what it has, and shows why. Reported once per
    /// change of what is missing.
    CannotRun {
        /// Device name from the client's hello.
        device: String,
        /// The UI sets the app imports that the host does not serve.
        missing: Vec<String>,
        /// The command that installs the app's host on the host's
        /// platform ([`DevServer::install_commands`]), if there is one.
        install: Option<String>,
    },
    /// A host's connection ended.
    Disconnected {
        /// Device name from the client's hello.
        device: String,
    },
    /// A log line from a host.
    Log(ClientLog),
    /// The mount items of a batch a traced test session's app applied, a
    /// line each ([`DevServer::set_test_trace`]); before the outcome of the
    /// step it came in.
    Trace {
        /// The items.
        items: Vec<String>,
    },
}

/// A log line received from a dev host.
#[derive(Debug, Clone)]
pub struct ClientLog {
    /// Device name from the client's hello.
    pub device: String,
    /// Severity.
    pub level: LogLevel,
    /// Source (`js` or a Rust module path).
    pub target: String,
    /// The message.
    pub message: String,
}

/// What a published bundle says about its app.
#[derive(Debug, Clone, Default)]
pub struct AppInfo {
    /// What the app declares it may reach (JSON), so development runs with
    /// the same capabilities as the release.
    pub capabilities: Option<String>,
    /// The app's id (`nsh.json` `"id"`), which names where it keeps its
    /// data.
    pub id: Option<String>,
    /// The main window's launch-time options (`nsh.json` `"window"`, JSON).
    pub window: Option<String>,
}

struct Bundle {
    version: u64,
    bytecode: axum::body::Bytes,
    source: axum::body::Bytes,
    source_map: Option<axum::body::Bytes>,
    capabilities: Option<String>,
    app_id: Option<String>,
    window: Option<String>,
    /// The UI sets it imports.
    ui_sets: Arc<[String]>,
}

struct Patch {
    version: u64,
    base: u64,
    code: axum::body::Bytes,
    source_map: Option<axum::body::Bytes>,
    /// The UI sets the bundle of `version` imports.
    ui_sets: Arc<[String]>,
}

#[derive(Clone)]
enum Event {
    /// The app is the host's own Rust root ([`DevServer::publish_root`]).
    Root,
    Building,
    Failed(Arc<str>),
    Patch(Arc<Patch>),
    Bundle(Arc<Bundle>),
}

struct Shared {
    /// Directory whose media files are served at `/assets/` (the app's
    /// source directory; [`asset_in_root`] says which of its files).
    assets_root: Option<std::path::PathBuf>,
    /// Files served at `/assets/<path>` by name: the app's imported assets
    /// and the files the UI sets' crates ship, by path.
    files: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    /// The web host's files ([`DevServer::serve_web`]), by path (`""`:
    /// the page).
    web: Mutex<std::collections::HashMap<String, axum::body::Bytes>>,
    /// The commands that install the app's host, by platform.
    install: Mutex<std::collections::HashMap<HostPlatform, String>>,
    /// The limits hosts run apps with ([`DevServer::set_limits`]).
    limits: Mutex<Option<String>>,
    /// The state a newly connected client must see first.
    latest: Mutex<Option<Event>>,
    events: broadcast::Sender<Event>,
    bytecode_version: String,
    /// This run of the server ([`ServerMessage::Hello`]).
    session: u64,
    /// Hosts connected now.
    clients: AtomicUsize,
    on_event: Box<dyn Fn(ClientEvent) + Send + Sync>,
    /// A test session ([`DevServer::test_session`]).
    test: AtomicBool,
    /// The connected hosts that take test steps, oldest first: their
    /// connection's id and what sends it a message.
    testers: Mutex<Vec<(u64, tokio::sync::mpsc::UnboundedSender<ServerMessage>)>>,
    /// The steps waiting for an outcome, by id: their host's connection and
    /// who waits.
    steps: Mutex<std::collections::HashMap<u64, (u64, std::sync::mpsc::Sender<StepOutcome>)>>,
    next_step: AtomicU64,
    next_connection: AtomicU64,
    /// What a test session's app starts with: its storage's entries.
    test_storage: Mutex<Vec<(String, String)>>,
    /// Whether a test session's app is traced ([`DevServer::set_test_trace`]).
    test_trace: AtomicBool,
    /// What a test session fixes of its app's environment
    /// ([`DevServer::set_test_environment`]).
    test_environment: Mutex<crate::protocol::TestEnvironment>,
    /// What answers a test session's app's requests.
    test_network: Mutex<Option<Arc<dyn TestNetwork>>>,
}

/// What cancels the test's answers to requests, by id.
type Cancels = std::collections::HashMap<u64, Box<dyn FnOnce() + Send>>;

/// An id for this run of the server, different from earlier runs' (the
/// clock and the process).
fn new_session() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    nanos ^ (u64::from(std::process::id()) << 40)
}

/// The dev server: serves the latest bundle to dev hosts and pushes
/// rebuilds to them. Dropping it stops the server.
pub struct DevServer {
    shared: Arc<Shared>,
    addr: SocketAddr,
    next_version: Mutex<u64>,
    _runtime: tokio::runtime::Runtime,
}

impl DevServer {
    /// Starts listening on `addr`. `bytecode_version` is the format of the
    /// bytecode this server publishes; clients reporting another version get
    /// JS source instead. `on_event` receives what hosts do (connecting,
    /// disconnecting, their log lines), on the server's threads.
    ///
    /// `/assets/<path>` serves the files [`DevServer::serve_files`] names
    /// and, from `assets_root`, only images, fonts, audio and video outside
    /// hidden directories ([`asset_in_root`]): never the app's sources, its
    /// `nsh.json`, `.env` or other configuration. `/ws` refuses browsers
    /// whose page is not the server's own ([`allowed_origin`]).
    pub fn start(
        addr: SocketAddr,
        bytecode_version: impl Into<String>,
        assets_root: Option<std::path::PathBuf>,
        on_event: impl Fn(ClientEvent) + Send + Sync + 'static,
    ) -> io::Result<DevServer> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("nsh-dev-server")
            .enable_all()
            .build()?;
        let shared = Arc::new(Shared {
            assets_root: assets_root.and_then(|p| dunce::canonicalize(p).ok()),
            files: Mutex::default(),
            web: Mutex::default(),
            install: Mutex::default(),
            limits: Mutex::default(),
            latest: Mutex::new(None),
            events: broadcast::channel(16).0,
            bytecode_version: bytecode_version.into(),
            session: new_session(),
            clients: AtomicUsize::new(0),
            on_event: Box::new(on_event),
            test: AtomicBool::new(false),
            testers: Mutex::default(),
            steps: Mutex::default(),
            next_step: AtomicU64::new(1),
            next_connection: AtomicU64::new(1),
            test_storage: Mutex::default(),
            test_trace: AtomicBool::new(false),
            test_environment: Mutex::default(),
            test_network: Mutex::new(None),
        });
        let listener = runtime.block_on(tokio::net::TcpListener::bind(addr))?;
        let addr = listener.local_addr()?;
        let app = Router::new()
            .route(WS_PATH, get(upgrade))
            .route("/bundle.js", get(bundle_source))
            .route("/assets/{*path}", get(asset))
            .fallback(web_file)
            .with_state(shared.clone());
        runtime.spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                log::error!("dev server stopped: {err}");
            }
        });
        Ok(DevServer {
            shared,
            addr,
            next_version: Mutex::new(0),
            _runtime: runtime,
        })
    }

    /// Serves each `(path, file)` at `/assets/<path>` (`asset:/<path>` on
    /// device), whatever its type: the assets a build imported and the
    /// files the crates of Rust components ship. The assets root serves
    /// only media files besides them ([`DevServer::start`]).
    pub fn serve_files(&self, files: impl IntoIterator<Item = (String, std::path::PathBuf)>) {
        self.shared.files.lock().expect("files lock").extend(files);
    }

    /// Serves the web host: `page` (HTML) at `/` and each `(path,
    /// bytes)` at `/<path>` (the runtime's `nsh.js` and `nsh.wasm`). The
    /// page connects to [`WS_PATH`] as the other hosts do, saying it runs
    /// JS source ([`ClientMessage::Hello`]).
    pub fn serve_web(&self, page: String, files: impl IntoIterator<Item = (String, Vec<u8>)>) {
        let mut web = self.shared.web.lock().expect("web lock");
        web.insert(String::new(), page.into());
        web.extend(files.into_iter().map(|(path, bytes)| (path, bytes.into())));
    }

    /// Whether [`DevServer::serve_web`] was called: browsers can open the
    /// app at `http://<address>/`.
    pub fn serves_web(&self) -> bool {
        !self.shared.web.lock().expect("web lock").is_empty()
    }

    /// Sets the command that installs the app's host, for each platform
    /// there is one for: hosts that cannot run the app show it
    /// ([`ClientEvent::CannotRun`]).
    pub fn install_commands(&self, commands: impl IntoIterator<Item = (HostPlatform, String)>) {
        *self.shared.install.lock().expect("install lock") = commands.into_iter().collect();
    }

    /// The VM limits hosts run the apps with, from the next bundle on:
    /// those an embedding app would set (`nsh_core::js::HostLimits`'
    /// syntax, as `nsh run --limits` takes them; empty: the embedding
    /// defaults), or `None` (the default): none, as an app on its own.
    pub fn set_limits(&self, limits: Option<String>) {
        *self.shared.limits.lock().expect("limits lock") = limits;
    }

    /// The bound address (useful with port 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The number of hosts connected now.
    pub fn clients(&self) -> usize {
        self.shared.clients.load(Ordering::Relaxed)
    }

    /// Makes this a test session (`nsh test --target`): hosts connecting
    /// from now on are told to keep the model of their app that test steps
    /// need ([`DevServer::step`]).
    pub fn test_session(&self) {
        self.shared.test.store(true, Ordering::Relaxed);
    }

    /// The storage a test session's app starts with, in place of its own
    /// (hosts connecting from now on).
    pub fn set_test_storage(&self, entries: Vec<(String, String)>) {
        *self.shared.test_storage.lock().expect("storage lock") = entries;
    }

    /// What a test session fixes of its app's environment, and its
    /// clipboard (hosts connecting from now on).
    pub fn set_test_environment(&self, environment: crate::protocol::TestEnvironment) {
        *self
            .shared
            .test_environment
            .lock()
            .expect("environment lock") = environment;
    }

    /// Traces a test session's app (`nsh test --trace`; hosts connecting
    /// from now on): its engine logs each commit's timings, and each batch
    /// it applies comes as a [`ClientEvent::Trace`].
    pub fn set_test_trace(&self, trace: bool) {
        self.shared.test_trace.store(trace, Ordering::Relaxed);
    }

    /// What answers a test session's app's requests: without one, the
    /// hosts make them themselves.
    pub fn set_test_network(&self, network: Arc<dyn TestNetwork>) {
        *self.shared.test_network.lock().expect("network lock") = Some(network);
    }

    /// Whether a host that takes test steps is connected.
    pub fn has_tester(&self) -> bool {
        !self.shared.testers.lock().expect("testers lock").is_empty()
    }

    /// Asks the host that connected last of those taking test steps to
    /// take `step`, and waits for its outcome, `timeout` at most: what a
    /// query gives (`null` for actions), or why it failed. Blocks: call it
    /// off the server's threads.
    pub fn step(&self, step: TestStep, timeout: Duration) -> Result<serde_json::Value, String> {
        let shared = &self.shared;
        let (connection, host) = shared
            .testers
            .lock()
            .expect("testers lock")
            .last()
            .cloned()
            .ok_or("no host that takes test steps is connected")?;
        let id = shared.next_step.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        shared
            .steps
            .lock()
            .expect("steps lock")
            .insert(id, (connection, tx));
        if host.send(ServerMessage::Step { id, step }).is_err() {
            shared.steps.lock().expect("steps lock").remove(&id);
            return Err("the host left".into());
        }
        let outcome = rx.recv_timeout(timeout);
        shared.steps.lock().expect("steps lock").remove(&id);
        match outcome {
            Ok(StepOutcome::Done { value }) => Ok(value),
            Ok(StepOutcome::Failed { message }) => Err(message),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "the host did not take the step in {} s",
                timeout.as_secs_f64()
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("the host left".into()),
        }
    }

    /// Announces that a rebuild started.
    pub fn building(&self) {
        let _ = self.shared.events.send(Event::Building);
    }

    /// Publishes a new bundle (and its source map) to every client that
    /// serves the `ui_sets` it imports (by specifier); the others are told
    /// they cannot run it ([`ClientEvent::CannotRun`]). With a `patch` (a
    /// hot update script from the previous bundle, and its source map),
    /// clients running the previous bundle update in place.
    pub fn publish(
        &self,
        bytecode: Vec<u8>,
        source: String,
        source_map: Option<String>,
        app: AppInfo,
        patch: Option<(String, Option<String>)>,
        ui_sets: Vec<String>,
    ) {
        let ui_sets: Arc<[String]> = ui_sets.into();
        let version = {
            let mut next = self.next_version.lock().expect("version lock");
            *next += 1;
            *next
        };
        if let Some((code, map)) = patch
            && version > 1
        {
            // Only for clients connected now: new clients get the bundle.
            let _ = self.shared.events.send(Event::Patch(Arc::new(Patch {
                version,
                base: version - 1,
                code: code.into(),
                source_map: map.map(Into::into),
                ui_sets: ui_sets.clone(),
            })));
        }
        self.set(Event::Bundle(Arc::new(Bundle {
            version,
            bytecode: bytecode.into(),
            source: source.into(),
            source_map: source_map.map(Into::into),
            capabilities: app.capabilities,
            app_id: app.id,
            window: app.window,
            ui_sets,
        })));
    }

    /// Publishes the app as the hosts' own Rust root (`nsh.json` `"root"`,
    /// an app of Rust only, whose hosts are built with it): they run it in
    /// place of a bundle.
    pub fn publish_root(&self) {
        self.set(Event::Root);
    }

    /// Publishes a build error; clients keep running the last good bundle
    /// and show the error.
    pub fn publish_error(&self, message: impl Into<Arc<str>>) {
        self.set(Event::Failed(message.into()));
    }

    fn set(&self, event: Event) {
        *self.shared.latest.lock().expect("latest lock") = Some(event.clone());
        let _ = self.shared.events.send(event);
    }
}

async fn bundle_source(State(shared): State<Arc<Shared>>) -> Response {
    let latest = shared.latest.lock().expect("latest lock").clone();
    match latest {
        Some(Event::Bundle(bundle)) => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
            bundle.source.clone(),
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serves an app asset (`asset:/<path>` on device). Only the files
/// [`DevServer::serve_files`] named and the media files inside the assets
/// root ([`asset_in_root`]) are reachable.
async fn asset(
    State(shared): State<Arc<Shared>>,
    axum::extract::Path(path): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let named = shared.files.lock().expect("files lock").get(&path).cloned();
    let file = match named {
        Some(file) => file,
        None => {
            let Some(root) = &shared.assets_root else {
                return StatusCode::NOT_FOUND.into_response();
            };
            match asset_in_root(root, &path) {
                Some(file) => file,
                None => return StatusCode::NOT_FOUND.into_response(),
            }
        }
    };
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let kind = nsh_core::platform::content_type(&file.to_string_lossy());
    let range = headers
        .get(header::RANGE)
        .and_then(|r| r.to_str().ok())
        .map(|r| byte_range(r, bytes.len() as u64));
    // Media players (AVFoundation's) read media by ranges, and give up on
    // a server that answers none.
    match range {
        None => (
            [
                (header::CONTENT_TYPE, kind.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        Some(Some((start, end))) => (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, kind.to_owned()),
                (header::ACCEPT_RANGES, "bytes".to_owned()),
                (
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{}", bytes.len()),
                ),
            ],
            bytes[start as usize..=end as usize].to_vec(),
        )
            .into_response(),
        Some(None) => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{}", bytes.len()))],
        )
            .into_response(),
    }
}

/// The bytes a `Range` header asks of a file of `len` bytes, first and last
/// included: one range (`bytes=0-1`, `bytes=100-`, `bytes=-500`); `None`
/// when it asks for none of them (or for several, which no media player
/// does).
fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().ok()?;
            if suffix == 0 {
                return None;
            }
            (len.saturating_sub(suffix), len - 1)
        }
        (start, "") => (start.parse().ok()?, len - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

/// The file `path` names under `root` (canonical), when the dev server may
/// serve it without a build naming it: a media file (an image, a font,
/// audio or video, by its extension), with no part of its path hidden
/// (`.env`, `.git/`) or a directory of tools (`.nsh`, `node_modules`,
/// `target`), inside `root` once links are followed, and the same
/// holds for the file a link leads to. Scripts, sources, JSON and every
/// other file reach hosts only as a build's imported assets.
pub(crate) fn asset_in_root(root: &std::path::Path, path: &str) -> Option<std::path::PathBuf> {
    let servable = |rel: &std::path::Path| {
        let mut parts = rel.components().peekable();
        parts.peek().is_some()
            && parts.all(|part| match part {
                std::path::Component::Normal(name) => name.to_str().is_some_and(|name| {
                    !name.starts_with('.') && name != "node_modules" && name != "target"
                }),
                _ => false,
            })
            && is_media(rel)
    };
    if !servable(std::path::Path::new(path)) {
        return None;
    }
    let file = dunce::canonicalize(root.join(path)).ok()?;
    let rel = file.strip_prefix(root).ok()?;
    (servable(rel) && file.is_file()).then_some(file)
}

/// Whether a file is an image, a font, audio or video, by its extension:
/// what an app shows from its directory.
fn is_media(path: &std::path::Path) -> bool {
    let kind = nsh_core::platform::content_type(&path.to_string_lossy());
    ["image/", "font/", "audio/", "video/"]
        .iter()
        .any(|prefix| kind.starts_with(prefix))
}

/// The web host's page and runtime ([`DevServer::serve_web`]); never
/// cached, as they change with the runtime. A browser loading one of the
/// app's own paths gets the page ([`wants_page`]).
async fn web_file(
    State(shared): State<Arc<Shared>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path == "index.html" { "" } else { path };
    let bytes = {
        let web = shared.web.lock().expect("web lock");
        match web.get(path) {
            Some(bytes) => Some((path, bytes.clone())),
            None if wants_page(&method, &uri, &headers) => web.get("").map(|b| ("", b.clone())),
            None => None,
        }
    };
    match bytes {
        Some((path, bytes)) => {
            let content_type = match path {
                "" => "text/html; charset=utf-8",
                path => nsh_core::platform::content_type(path),
            };
            (
                [
                    (header::CONTENT_TYPE, content_type),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                bytes,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Whether a request is a browser loading the page at one of the app's own
/// paths (`/sports/football`, a link into the app or a reload after it
/// moved there): a `GET` of a path whose last segment has no extension,
/// accepting HTML. The page answers it where no file does, as hosts of
/// single-page apps rewrite such paths to `index.html`; requests for files
/// (`/logo.png`) and the app's own requests (`fetch` accepts `*/*`) still
/// get their 404.
pub(crate) fn wants_page(method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    let name = uri.path().rsplit('/').next().unwrap_or_default();
    (method == Method::GET || method == Method::HEAD)
        && !name.contains('.')
        && headers
            .get_all(header::ACCEPT)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(|kind| kind.split(';').next().unwrap_or_default().trim())
            .any(|kind| {
                kind.eq_ignore_ascii_case("text/html")
                    || kind.eq_ignore_ascii_case("application/xhtml+xml")
            })
}

async fn upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(shared): State<Arc<Shared>>,
) -> Response {
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    if !allowed_origin(header(header::ORIGIN), header(header::HOST)) {
        log::warn!(
            "dev server: refused a WebSocket from the page at {}",
            header(header::ORIGIN).unwrap_or_default()
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    // Bundles are ~100 KB of bytecode; allow generous frames.
    ws.max_message_size(64 << 20)
        .on_upgrade(move |socket| async move {
            if let Err(err) = serve_client(socket, shared).await {
                log::debug!("dev client disconnected: {err}");
            }
        })
}

/// Whether a WebSocket handshake with these `Origin` and `Host` headers
/// may connect. Native hosts send no `Origin`. A browser always does: its
/// page must be the dev server's own (the web host, which connects to
/// `location.host`), so the origin is `http(s)://` and the very host the
/// request names, and that host an IP address or `localhost`. Any other
/// page open in a browser on this machine or the network is refused, even
/// one whose name resolves to this machine (DNS rebinding).
pub(crate) fn allowed_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(host) = host else {
        return false;
    };
    let Some(origin_host) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    if !origin_host.eq_ignore_ascii_case(host) {
        return false;
    }
    // The host without its port: `[::1]:80`, `127.0.0.1:80`, `localhost`.
    let name = match host.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((ip, port)) if port.is_empty() || port.starts_with(':') => ip,
            _ => return false,
        },
        None => host.rsplit_once(':').map_or(host, |(name, _)| name),
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok()
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

async fn serve_client(mut socket: WebSocket, shared: Arc<Shared>) -> Result<(), BoxError> {
    let hello = tokio::time::timeout(Duration::from_secs(5), socket.recv())
        .await
        .map_err(|_| "no hello")?
        .ok_or("closed before hello")??;
    let Message::Text(text) = hello else {
        return Err("expected hello".into());
    };
    let ClientMessage::Hello {
        protocol,
        bytecode_version,
        device,
        platform,
        ui_sets,
        tests,
    } = serde_json::from_str(&text)?
    else {
        return Err("expected hello".into());
    };
    if protocol != PROTOCOL_VERSION {
        return Err(
            format!("{device}: protocol {protocol}, server speaks {PROTOCOL_VERSION}").into(),
        );
    }
    let format = if bytecode_version == shared.bytecode_version {
        BundleFormat::Bytecode
    } else if bytecode_version.is_empty() {
        BundleFormat::Source
    } else {
        log::warn!(
            "{device}: bytecode {bytecode_version} != {}, sending JS source",
            shared.bytecode_version
        );
        BundleFormat::Source
    };
    send(
        &mut socket,
        &ServerMessage::Hello {
            protocol: PROTOCOL_VERSION,
            session: shared.session,
            test: shared.test.load(Ordering::Relaxed),
        },
    )
    .await?;

    let mut host = Host {
        device,
        platform,
        ui_sets,
        format,
        refused: None,
    };

    // Subscribe before reading the latest state so no event is missed.
    let mut events = shared.events.subscribe();
    let latest = shared.latest.lock().expect("latest lock").clone();
    let build = match &latest {
        Some(Event::Bundle(bundle)) if host.missing(&bundle.ui_sets).is_empty() => {
            Some(bundle.version)
        }
        _ => None,
    };
    let device = host.device.clone();
    let _connection = Connection::new(&shared, &device, build);
    // A host taking a test session's steps: steps reach it through `steps`.
    let (step_tx, mut steps) = tokio::sync::mpsc::unbounded_channel();
    let testing = tests && shared.test.load(Ordering::Relaxed);
    let _tester = testing.then(|| Tester::new(&shared, step_tx.clone()));
    if testing {
        // Before the first bundle: what the app starts with.
        let storage = shared.test_storage.lock().expect("storage lock").clone();
        let trace = shared.test_trace.load(Ordering::Relaxed);
        let environment = shared
            .test_environment
            .lock()
            .expect("environment lock")
            .clone();
        send(
            &mut socket,
            &ServerMessage::TestSetup {
                storage,
                trace,
                environment,
            },
        )
        .await?;
    }
    // The app's requests the test answers, by id: what cancels them.
    let fetches: Arc<Mutex<Cancels>> = Arc::default();
    if let Some(event) = latest {
        send_event(&mut socket, &shared, &mut host, &event).await?;
    }
    loop {
        tokio::select! {
            Some(step) = steps.recv() => send(&mut socket, &step).await?,
            event = events.recv() => match event {
                Ok(event) => send_event(&mut socket, &shared, &mut host, &event).await?,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let latest = shared.latest.lock().expect("latest lock").clone();
                    if let Some(event) = latest {
                        send_event(&mut socket, &shared, &mut host, &event).await?;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                    Ok(ClientMessage::Log { level, target, message }) => {
                        (shared.on_event)(ClientEvent::Log(ClientLog { device: device.clone(), level, target, message }));
                    }
                    Ok(ClientMessage::StepDone { id, outcome }) => {
                        if let Some((_, waiting)) = shared.steps.lock().expect("steps lock").remove(&id) {
                            let _ = waiting.send(outcome);
                        }
                    }
                    Ok(ClientMessage::Fetch { id, request }) => {
                        let network = shared.test_network.lock().expect("network lock").clone();
                        let replies = step_tx.clone();
                        match network {
                            None => {
                                let _ = replies.send(ServerMessage::Fetch { id, reply: FetchReply::Pass });
                            }
                            Some(network) => {
                                let done = fetches.clone();
                                let cancel = network.fetch(request, Box::new(move |reply| {
                                    if matches!(reply, FetchReply::Pass | FetchReply::End | FetchReply::Failed { .. }) {
                                        done.lock().expect("fetches lock").remove(&id);
                                    }
                                    let _ = replies.send(ServerMessage::Fetch { id, reply });
                                }));
                                fetches.lock().expect("fetches lock").insert(id, cancel);
                            }
                        }
                    }
                    Ok(ClientMessage::Trace { items }) => {
                        (shared.on_event)(ClientEvent::Trace { items });
                    }
                    Ok(ClientMessage::FetchCancel { id }) => {
                        let cancel = fetches.lock().expect("fetches lock").remove(&id);
                        if let Some(cancel) = cancel {
                            cancel();
                        }
                    }
                    _ => {}
                },
                Some(Ok(_)) => {}
                Some(Err(err)) => return Err(err.into()),
                None => return Ok(()),
            },
        }
    }
}

/// What the server knows of a connected host.
struct Host {
    device: String,
    platform: Option<HostPlatform>,
    /// The UI sets it serves (`None`: it does not say).
    ui_sets: Option<Vec<String>>,
    /// The format of the bundles it gets.
    format: BundleFormat,
    /// What it was last told it lacks, while it gets no bundles.
    refused: Option<Vec<String>>,
}

impl Host {
    /// The UI sets of `needed` the host does not serve.
    fn missing(&self, needed: &[String]) -> Vec<String> {
        match &self.ui_sets {
            Some(has) => needed
                .iter()
                .filter(|s| !has.contains(s))
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }
}

/// What a host that cannot run the app shows (as prose: hosts wrap it to
/// their screen).
fn cannot_run_message(missing: &[String], install: Option<&str>) -> String {
    let sets = match missing {
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        [] => String::new(),
    };
    let mut prose = format!(
        "The app imports {sets}, which this host does not have: it was built for another app."
    );
    if install.is_some() {
        prose.push_str(" To install this app's host, run");
    }
    let mut message = prose;
    if let Some(install) = install {
        message.push_str(&format!("\n\n  {install}"));
    }
    message
}

/// A host connected after its hello: counted and reported until its
/// session ends, however it ends.
struct Connection<'a> {
    shared: &'a Shared,
    device: &'a str,
}

impl<'a> Connection<'a> {
    fn new(shared: &'a Shared, device: &'a str, build: Option<u64>) -> Self {
        shared.clients.fetch_add(1, Ordering::Relaxed);
        (shared.on_event)(ClientEvent::Connected {
            device: device.to_owned(),
            build,
        });
        Connection { shared, device }
    }
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        self.shared.clients.fetch_sub(1, Ordering::Relaxed);
        (self.shared.on_event)(ClientEvent::Disconnected {
            device: self.device.to_owned(),
        });
    }
}

/// A host taking test steps, while it is connected: its steps fail when
/// it leaves.
struct Tester<'a> {
    shared: &'a Shared,
    id: u64,
}

impl<'a> Tester<'a> {
    fn new(shared: &'a Shared, steps: tokio::sync::mpsc::UnboundedSender<ServerMessage>) -> Self {
        let id = shared.next_connection.fetch_add(1, Ordering::Relaxed);
        shared
            .testers
            .lock()
            .expect("testers lock")
            .push((id, steps));
        Tester { shared, id }
    }
}

impl Drop for Tester<'_> {
    fn drop(&mut self) {
        self.shared
            .testers
            .lock()
            .expect("testers lock")
            .retain(|(id, _)| *id != self.id);
        // Its waiting steps end now: dropping their senders.
        self.shared
            .steps
            .lock()
            .expect("steps lock")
            .retain(|_, (connection, _)| *connection != self.id);
    }
}

async fn send(socket: &mut WebSocket, msg: &ServerMessage) -> Result<(), BoxError> {
    socket
        .send(Message::Text(serde_json::to_string(msg)?.into()))
        .await?;
    Ok(())
}

async fn send_event(
    socket: &mut WebSocket,
    shared: &Shared,
    host: &mut Host,
    event: &Event,
) -> Result<(), BoxError> {
    match event {
        Event::Root => send(socket, &ServerMessage::Root).await,
        Event::Building => send(socket, &ServerMessage::Building).await,
        // It cannot run the last good build either: it keeps showing why.
        Event::Failed(_) if host.refused.is_some() => Ok(()),
        Event::Failed(message) => {
            send(
                socket,
                &ServerMessage::BuildFailed {
                    message: message.to_string(),
                },
            )
            .await
        }
        // The bundle that follows says why.
        Event::Patch(patch) if !host.missing(&patch.ui_sets).is_empty() => Ok(()),
        Event::Patch(patch) => {
            send(
                socket,
                &ServerMessage::Patch {
                    version: patch.version,
                    base: patch.base,
                    source_map: patch.source_map.is_some(),
                },
            )
            .await?;
            socket.send(Message::Binary(patch.code.clone())).await?;
            if let Some(map) = &patch.source_map {
                socket.send(Message::Binary(map.clone())).await?;
            }
            Ok(())
        }
        Event::Bundle(bundle) => {
            let missing = host.missing(&bundle.ui_sets);
            if !missing.is_empty() {
                if host.refused.as_ref() == Some(&missing) {
                    return Ok(());
                }
                let install = host.platform.and_then(|p| {
                    shared
                        .install
                        .lock()
                        .expect("install lock")
                        .get(&p)
                        .cloned()
                });
                let message = cannot_run_message(&missing, install.as_deref());
                send(
                    socket,
                    &ServerMessage::CannotRun {
                        missing: missing.clone(),
                        message,
                    },
                )
                .await?;
                (shared.on_event)(ClientEvent::CannotRun {
                    device: host.device.clone(),
                    missing: missing.clone(),
                    install,
                });
                host.refused = Some(missing);
                return Ok(());
            }
            host.refused = None;
            let format = host.format;
            let limits = shared.limits.lock().expect("limits lock").clone();
            send(
                socket,
                &ServerMessage::Bundle {
                    version: bundle.version,
                    format,
                    source_map: bundle.source_map.is_some(),
                    capabilities: bundle.capabilities.clone(),
                    app_id: bundle.app_id.clone(),
                    window: bundle.window.clone(),
                    limits,
                },
            )
            .await?;
            let payload = match format {
                BundleFormat::Bytecode => bundle.bytecode.clone(),
                BundleFormat::Source => bundle.source.clone(),
            };
            socket.send(Message::Binary(payload)).await?;
            if let Some(map) = &bundle.source_map {
                socket.send(Message::Binary(map.clone())).await?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, Method, Uri, header};

    fn wants_page(method: Method, path: &str, accept: &str) -> bool {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, HeaderValue::from_str(accept).unwrap());
        super::wants_page(&method, &path.parse::<Uri>().unwrap(), &headers)
    }

    #[test]
    fn browsers_loading_the_apps_paths_get_the_page() {
        let browser = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        assert!(wants_page(Method::GET, "/sports/football", browser));
        assert!(wants_page(
            Method::GET,
            "/sports/football?tab=live",
            browser
        ));
        assert!(wants_page(Method::GET, "/sports/", browser));
        assert!(wants_page(Method::HEAD, "/v1.2/teams", browser));
        assert!(wants_page(Method::GET, "/a", "application/xhtml+xml"));
        // Files, the app's own requests and other methods are not pages.
        assert!(!wants_page(Method::GET, "/logo.png", browser));
        assert!(!wants_page(Method::GET, "/sports/app.js", browser));
        assert!(!wants_page(Method::GET, "/api/teams", "*/*"));
        assert!(!wants_page(Method::GET, "/api/teams", "application/json"));
        assert!(!wants_page(Method::POST, "/sports/football", browser));
        assert!(!wants_page(Method::GET, "/api", "text/htmlx"));
    }

    #[test]
    fn only_the_dev_servers_own_pages_and_native_hosts_open_the_websocket() {
        use super::allowed_origin;
        // Native hosts send no Origin.
        assert!(allowed_origin(None, Some("127.0.0.1:18790")));
        assert!(allowed_origin(None, None));
        // The web host, at each address a browser may open it on.
        for host in [
            "127.0.0.1:18790",
            "localhost:18790",
            "LOCALHOST:18790",
            "192.168.1.20:18790",
            "[::1]:18790",
            "[fe80::1]",
            "127.0.0.1",
        ] {
            assert!(
                allowed_origin(Some(&format!("http://{host}")), Some(host)),
                "{host}"
            );
        }
        assert!(allowed_origin(
            Some("https://127.0.0.1:443"),
            Some("127.0.0.1:443")
        ));
        // Other pages.
        for (origin, host) in [
            ("https://evil.example", "127.0.0.1:18790"),
            ("http://127.0.0.1:3000", "127.0.0.1:18790"),
            ("http://localhost:18790", "127.0.0.1:18790"),
            ("null", "127.0.0.1:18790"),
            ("file://", "127.0.0.1:18790"),
            ("http://127.0.0.1:18790/", "127.0.0.1:18790"),
            // A name rebound to this machine: same origin, but not an
            // address or localhost.
            ("http://evil.example:18790", "evil.example:18790"),
            ("http://[::1]x", "[::1]x"),
        ] {
            assert!(
                !allowed_origin(Some(origin), Some(host)),
                "{origin} at {host}"
            );
        }
        assert!(!allowed_origin(Some("http://127.0.0.1:18790"), None));
    }

    #[test]
    fn the_assets_root_serves_media_files_only() {
        let root = std::env::temp_dir().join(format!("nsh-dev-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for file in [
            "logo.png",
            "img/photo@2x.jpg",
            "fonts/Inter.woff2",
            ".env",
            "App.tsx",
            "nsh.json",
            "notes.txt",
            ".git/logo.png",
            ".nsh/types/a.png",
            "node_modules/x/a.png",
            "target/a.png",
        ] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"x").unwrap();
        }
        let outside = root.with_extension("outside.png");
        std::fs::write(&outside, b"x").unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        let served = |path: &str| super::asset_in_root(&root, path).is_some();
        assert!(served("logo.png"));
        assert!(served("img/photo@2x.jpg"));
        assert!(served("fonts/Inter.woff2"));
        for path in [
            ".env",
            "App.tsx",
            "nsh.json",
            "notes.txt",
            ".git/logo.png",
            ".nsh/types/a.png",
            "node_modules/x/a.png",
            "target/a.png",
            "missing.png",
            "img",
            "",
            "img/../logo.png",
        ] {
            assert!(!served(path), "{path}");
        }
        let name = outside.file_name().unwrap().to_str().unwrap();
        assert!(!served(&format!("../{name}")));
        #[cfg(unix)]
        {
            // A link named as an image leads to what it leads to.
            std::os::unix::fs::symlink(root.join(".env"), root.join("env.png")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("out.png")).unwrap();
            std::os::unix::fs::symlink(root.join("logo.png"), root.join("alias.png")).unwrap();
            assert!(!served("env.png"));
            assert!(!served("out.png"));
            assert!(served("alias.png"));
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn a_host_that_cannot_run_the_app_is_told_why() {
        let message = super::cannot_run_message(
            &["gallery/native".to_owned()],
            Some("nsh run examples/gallery-rs --target android"),
        );
        assert_eq!(
            message,
            "The app imports gallery/native, which this host does not have: it was built for \
             another app. To install this app's host, run\n\n  nsh run examples/gallery-rs \
             --target android"
        );
        let two = super::cannot_run_message(&["a/x".to_owned(), "b/y".to_owned()], None);
        assert!(
            two.starts_with("The app imports a/x and b/y, which"),
            "{two}"
        );
        assert!(!two.contains("run"), "{two}");
    }

    #[test]
    fn ranges_of_a_file() {
        let range = |h| super::byte_range(h, 1000);
        assert_eq!(range("bytes=0-1"), Some((0, 1)));
        assert_eq!(range("bytes=100-"), Some((100, 999)));
        assert_eq!(range("bytes=-500"), Some((500, 999)));
        assert_eq!(range("bytes=900-5000"), Some((900, 999)));
        assert_eq!(range("bytes=1000-"), None);
        assert_eq!(range("bytes=5-1"), None);
        assert_eq!(range("bytes=0-1,5-6"), None);
        assert_eq!(range("items=0-1"), None);
        assert_eq!(super::byte_range("bytes=0-", 0), None);
    }
}
