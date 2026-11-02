//! The engine thread of one surface.
//!
//! The engine owns a [`nsh_core::Core`] on a dedicated thread and runs one
//! app ([`App`]): a Rust app's root component, or a JS bundle in a QuickJS
//! VM (`nsh_js::Host`, feature `js-core`; `js` adds the standard modules
//! `zlib` and `crypto`). Each wake-up (input event, timer,
//! resize) runs the app's code (component tasks; JS and its microtasks),
//! applies what JS committed, lays out, and hands one [`MountBatch`] to the
//! platform through a [`MountSink`]. The platform thread never blocks on
//! the engine.

#[cfg(all(feature = "browser", target_arch = "wasm32", not(feature = "js-core")))]
pub mod browser;

mod access;
mod app_directory;
mod cache;
#[cfg(not(target_arch = "wasm32"))]
mod chunks;
mod error;
mod host_channel;
mod local_storage;
#[cfg(feature = "net")]
pub mod net;
pub mod perf;
mod script;
#[cfg(feature = "shader")]
pub mod shader;
#[cfg(not(target_arch = "wasm32"))]
mod storage;
#[cfg(feature = "js-core")]
mod symbolicate;

// The typed API check (docs/dev/geometry.md, "Typed API"): the scan is
// nsh-core's; this crate's lists are `unitless.txt` and `untyped.txt`.
#[cfg(test)]
#[path = "../../nsh-core/src/geometry/unit_scan.rs"]
mod unit_scan;

#[cfg(test)]
#[test]
fn public_api_is_typed() {
    unit_scan::check(std::path::Path::new(env!("CARGO_MANIFEST_DIR")), &[]);
}

use std::{io, mem::ManuallyDrop, rc::Rc, sync::Arc, time::Duration};

pub use app_directory::app_dir_name;
#[cfg(not(target_arch = "wasm32"))]
pub use chunks::{ChunkLoad, ChunkLoader, ChunkSource};
use crossbeam_channel::{Receiver, Sender};
pub use local_storage::local_storage_prefix;
use nsh_core::{
    ApplyError, Core, EdgeInsets, EventKind, EventPayload, ListBind, MountBatch, NodeId, Op,
    PayloadValue, TextEngine, element::JsEvent, time::Instant,
};
pub use nsh_core::{
    JsonValue,
    access::{Access, Capabilities},
    element::{EngineContext, Root, Tokens},
    geometry::{self, Bounds, Edges, Point, Points, Size},
    js::{HostLimits, Limits},
    platform::{
        ColorScheme, Environment, FetchEvent, FetchOp, HostEnvironment, HttpBody, HttpHead,
        HttpRequest, Idiom, Locale, Os, Renderer,
    },
    storage::{StorageBackend, StorageChange},
    time::Clock,
};
#[cfg(feature = "js-core")]
pub use nsh_js::BYTECODE_VERSION;
/// Signed packages, release-key certificates, revocations and trust stores.
#[cfg(feature = "js-core")]
pub use nsh_package as package;
use rustc_hash::FxHashMap;
#[cfg(not(target_arch = "wasm32"))]
pub use storage::{FileStorage, data_dir};

use crate::script::{NetworkQueue, RequestId, Script};
pub use crate::{
    cache::{ByteSize, CacheLocation, CacheOptions, CachePolicy},
    error::{AppError, AppErrorKind, PackageInfo},
    host_channel::{HostCall, HostChannel, HostReply, OpenUrlRequest},
};

#[cfg(not(target_arch = "wasm32"))]
/// Stack size of the engine thread. QuickJS recursion (and deep Solid
/// component trees) needs more than the 512 KiB default of secondary
/// threads on Apple platforms.
const ENGINE_STACK_SIZE: usize = 8 * 1024 * 1024;

/// Minimum time between idle cycle collections. QuickJS frees acyclic
/// garbage immediately; only cycles (such as detached node subtrees, whose
/// parent/child links reference each other) wait for the collector.
const IDLE_GC_INTERVAL: Duration = Duration::from_secs(1);

/// How long the engine has had nothing to do (no message, no timer due)
/// before an idle collection: a collection walks every object of the VM,
/// tens of milliseconds for an app holding a lot of data, so it waits for
/// a pause rather than land between the turns of a paste held down or of
/// work done in slices on timers. An engine never quiet that long (a
/// timer every few frames) still collects every [`IDLE_GC_LONGEST`].
const IDLE_GC_QUIET: Duration = Duration::from_millis(300);

/// The longest time between idle collections, quiet or not.
const IDLE_GC_LONGEST: Duration = Duration::from_secs(5);

/// The shortest time between two deliveries of mouse motion: a frame at
/// 120 Hz. Mice report moves far more often (up to 1000 Hz), and a handler
/// that redraws a crosshair needs no more than one per frame.
const MOUSE_MOVE_INTERVAL: Duration = Duration::from_millis(8);

/// The app an engine runs.
#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "one app per surface; keep the public constructor API without allocation"
)]
pub enum App {
    /// A Rust app: its root component, mounted as the surface's content.
    Rust(Root),
    /// A JS app (feature `js-core`).
    Js(Bundle),
}

impl From<Bundle> for App {
    fn from(bundle: Bundle) -> Self {
        App::Js(bundle)
    }
}

impl App {
    /// The app's id (`nsh.json` `"id"`), when it carries one.
    pub fn app_id(&self) -> Option<&str> {
        match self {
            App::Rust(root) => root.app_id_ref(),
            App::Js(bundle) => bundle.app_id.as_deref(),
        }
    }
}

impl From<Root> for App {
    fn from(root: Root) -> Self {
        App::Rust(root)
    }
}

/// An app bundle: its code plus, in development, a source map.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct Bundle {
    /// The code.
    pub code: BundleCode,
    /// Source map (JSON) used to show app source locations in stack traces.
    pub source_map: Option<Arc<str>>,
    /// What the code may do.
    pub policy: Policy,
    /// What relative request URLs resolve against (the page's URL on the
    /// web); `None`: they are invalid.
    pub base_url: Option<Arc<str>>,
    /// The chunks of a split bundle that come with it (`import()` loads
    /// them without asking the platform); those missing are asked of
    /// [`MountSink::load_chunk`]. Shared by the bundle's clones.
    pub chunks: Arc<Vec<Chunk>>,
    /// The app's id (`nsh.json` `"id"`; a signed package's verified one):
    /// it names where the app keeps its data (`nsh/storage`).
    pub app_id: Option<String>,
    /// Trusted filesystem anchors selected by the native host, never decoded
    /// from application code, its manifest or a development server message.
    /// Missing anchors deny relative and corresponding placeholder grants.
    pub system_paths: nsh_core::access::TrustedPaths,
    /// The signed package the bundle came from ([`Bundle::from_package`]),
    /// named in the app's errors ([`AppError::package`]).
    pub package: Option<Arc<PackageInfo>>,
}

/// A chunk of a split bundle (`nsh_bundler::Chunk`): app code that
/// `import()` loads on demand.
#[derive(Debug, Clone)]
pub struct Chunk {
    /// Its id (`Screen.js`), as the bundle imports it.
    pub id: String,
    /// The code.
    pub code: BundleCode,
    /// Source map (JSON), for stack traces.
    pub source_map: Option<Arc<str>>,
    /// The directory used by this module's imported images and fonts.
    pub asset_base: Option<Arc<str>>,
}

impl Chunk {
    /// A chunk as JS source.
    pub fn source(id: impl Into<String>, code: String) -> Self {
        Self {
            id: id.into(),
            code: BundleCode::Source(code),
            source_map: None,
            asset_base: None,
        }
    }

    /// A chunk as bytecode (`nsh_js::compile_chunk_bytecode`).
    ///
    /// # Safety
    ///
    /// As [`Bundle::bytecode`].
    pub unsafe fn bytecode(id: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            id: id.into(),
            code: BundleCode::Bytecode(bytes),
            source_map: None,
            asset_base: None,
        }
    }

    /// Attaches a source map.
    pub fn with_source_map(mut self, map: impl Into<Arc<str>>) -> Self {
        self.source_map = Some(map.into());
        self
    }

    /// Gives this module's imported assets a directory of their own.
    pub fn with_asset_base(mut self, base: impl Into<Arc<str>>) -> Self {
        self.asset_base = Some(base.into());
        self
    }
}

/// What a bundle's code may do.
#[derive(Debug, Clone)]
pub struct Policy {
    /// Run without `eval`, the function constructors and writable shared
    /// prototypes (see `nsh_js::HostOptions::harden`). On by default; off for
    /// development bundles.
    pub harden: bool,
    /// What the app declared (`nsh.json` `capabilities`); `None`: no
    /// declaration, everything.
    pub declared: Option<Capabilities>,
    /// What the embedding app grants at most; `None`: whatever the app
    /// declared.
    pub granted: Option<Capabilities>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            harden: true,
            declared: None,
            granted: None,
        }
    }
}

impl Policy {
    /// Development bundles: `eval` and friends stay (debugging); the
    /// capabilities are still enforced, so a missing one shows during
    /// development.
    pub fn development() -> Self {
        Self {
            harden: false,
            ..Self::default()
        }
    }

    /// What the app may reach under this policy.
    pub fn access(&self) -> Access {
        Access {
            declared: self.declared.clone().unwrap_or_else(Capabilities::all),
            granted: self.granted.clone(),
        }
    }
}

/// The code of a bundle.
#[derive(Debug, Clone)]
pub enum BundleCode {
    /// QuickJS bytecode from `nsh_js::compile_bytecode`.
    Bytecode(Vec<u8>),
    /// JS source; slower to start than bytecode.
    Source(String),
}

impl Default for Bundle {
    fn default() -> Self {
        Self::source(String::new())
    }
}

impl Bundle {
    /// A bytecode bundle.
    ///
    /// # Safety
    ///
    /// `bytes` must be bytecode from `nsh_js::compile_bytecode` for this
    /// runtime's `BYTECODE_VERSION`, from a trusted source: QuickJS does not
    /// validate bytecode, and loading crafted bytecode corrupts memory. Trusted
    /// are the app's own signed resources, a development server the developer
    /// pointed the host at, and verified packages ([`Bundle::from_package`]).
    pub unsafe fn bytecode(bytes: Vec<u8>) -> Self {
        Self {
            code: BundleCode::Bytecode(bytes),
            source_map: None,
            policy: Policy::default(),
            base_url: None,
            chunks: Arc::default(),
            app_id: None,
            system_paths: nsh_core::access::TrustedPaths::default(),
            package: None,
        }
    }

    /// A JS source bundle.
    pub fn source(code: String) -> Self {
        Self {
            code: BundleCode::Source(code),
            source_map: None,
            policy: Policy::default(),
            base_url: None,
            chunks: Arc::default(),
            app_id: None,
            system_paths: nsh_core::access::TrustedPaths::default(),
            package: None,
        }
    }

    /// Selects trusted source/package and home directory anchors. Supplying a
    /// path grants nothing by itself: the manifest and host grant must still
    /// allow the filesystem operation. Only existing absolute directories
    /// are accepted; unavailable anchors are left unset.
    pub fn with_system_paths(mut self, mut paths: nsh_core::access::TrustedPaths) -> Self {
        paths.plugin_dir = trusted_directory(paths.plugin_dir);
        paths.home_dir = trusted_directory(paths.home_dir);
        self.system_paths = paths;
        self
    }

    /// The app's id ([`Bundle::app_id`]), as `nsh.json` or the dev server
    /// gives it.
    pub fn with_app_id(mut self, id: Option<&str>) -> Self {
        self.app_id = id.map(str::to_owned);
        self
    }

    /// Attaches a source map.
    pub fn with_source_map(mut self, map: impl Into<Arc<str>>) -> Self {
        self.source_map = Some(map.into());
        self
    }

    /// Sets the URL relative request URLs resolve against.
    pub fn with_base_url(mut self, url: impl Into<Arc<str>>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Replaces the policy.
    pub fn with_policy(mut self, policy: Policy) -> Self {
        self.policy = policy;
        self
    }

    /// Adds chunks of a split bundle (see [`Bundle::chunks`]).
    pub fn with_chunks(mut self, chunks: impl IntoIterator<Item = Chunk>) -> Self {
        Arc::make_mut(&mut self.chunks).extend(chunks);
        self
    }

    /// Reads a JS source bundle written by `nsh build` (`bundle.js`), plus
    /// `bundle.js.map`, the app's `capabilities.json` and its id
    /// (`app.json` `"id"`) next to it if present. Bytecode (`bundle.nshc`) is refused: files can be replaced, and
    /// only [`Bundle::read_trusted`] (the app's own resources) or a verified
    /// package may load bytecode.
    pub fn read(path: &std::path::Path) -> io::Result<Bundle> {
        if path.extension().is_some_and(|e| e == "nshc") {
            return Err(io::Error::other(
                "bytecode only loads from the app's own resources or a signed package (.nshpkg); load bundle.js",
            ));
        }
        // SAFETY: not bytecode.
        unsafe { Self::read_trusted(path) }
    }

    /// Like [`Bundle::read`], also reading `bundle.nshc` as bytecode.
    ///
    /// # Safety
    ///
    /// A `.nshc` file must be trusted as [`Bundle::bytecode`] requires (e.g.
    /// inside the app's own signed bundle).
    pub unsafe fn read_trusted(path: &std::path::Path) -> io::Result<Bundle> {
        let bytes = std::fs::read(path)?;
        let bundle = if path.extension().is_some_and(|e| e == "nshc") {
            // SAFETY: guaranteed by the caller.
            unsafe { Bundle::bytecode(bytes) }
        } else {
            Bundle::source(String::from_utf8(bytes).map_err(io::Error::other)?)
        };
        let mut bundle = match std::fs::read_to_string(path.with_file_name("bundle.js.map")) {
            Ok(map) if !map.is_empty() => bundle.with_source_map(map),
            _ => bundle,
        };
        if let Ok(json) = std::fs::read_to_string(path.with_file_name("capabilities.json")) {
            bundle.policy.declared = Some(parse_capabilities(&json).map_err(io::Error::other)?);
        }
        bundle.app_id = read_app_id(&path.with_file_name("app.json"));
        bundle.system_paths.plugin_dir = nsh_core::access::canonicalize(path)?
            .parent()
            .map(std::path::Path::to_path_buf);
        Ok(bundle)
    }
}

#[cfg(feature = "js-core")]
impl Bundle {
    /// The bundle of a verified package: its bytecode when it was compiled
    /// for this runtime (else its source), its source map and its declared
    /// capabilities. What a newer signer wrote that this runtime does not
    /// know (header fields, files, capabilities) is logged and left out: an
    /// unknown capability is not granted.
    pub fn from_package(package: &nsh_package::VerifiedPackage) -> Result<Bundle, String> {
        for ignored in &package.ignored {
            log::warn!("package {}: ignored {ignored}", package.app.id);
        }
        let bundle = match package.bytecode() {
            // SAFETY: verified: signed by a certified release key, hashed,
            // and compiled for this runtime.
            Some(bytecode) => unsafe { Bundle::bytecode(bytecode.to_vec()) },
            None => Bundle::source(package.source.clone()),
        };
        let mut bundle = match &package.source_map {
            Some(map) => bundle.with_source_map(map.clone()),
            None => bundle,
        };
        if let Some(json) = &package.capabilities {
            let (declared, dropped) = Capabilities::from_json_lenient(json)?;
            for dropped in dropped {
                log::warn!("package {}: not granted: {dropped}", package.app.id);
            }
            bundle.policy.declared = Some(declared);
        }
        bundle.app_id = Some(package.app.id.clone());
        bundle.package = Some(Arc::new(PackageInfo {
            id: package.app.id.clone(),
            name: package.app.name.clone(),
            version: package.app.version.clone(),
            build: package.app.build,
            sha256: package.sha256.clone(),
        }));
        Ok(bundle)
    }
}

/// The `"id"` of an `app.json` (`nsh build`'s, a packaged app's).
fn read_app_id(path: &std::path::Path) -> Option<String> {
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    json.get("id")?.as_str().map(str::to_owned)
}

/// A verified package, unpacked ([`load_package`], [`verify_package`]).
#[cfg(feature = "js-core")]
#[derive(Debug)]
pub struct LoadedPackage {
    /// Its bundle.
    pub bundle: Bundle,
    /// Where its assets are (`asset:/…`).
    pub assets: std::path::PathBuf,
    /// Its app.
    pub app: nsh_package::App,
    /// What accepting it records ([`accept_package`]).
    pub receipt: nsh_package::PackageReceipt,
}

/// Verifies the package `bytes` with `trust`, writes its assets under
/// `assets_root` (`<root>/<app id>/<package hash>/`, once per package) and
/// records its build (older builds of the app are refused from now on):
/// [`verify_package`], then [`accept_package`].
#[cfg(feature = "js-core")]
pub fn load_package(
    trust: &mut nsh_package::TrustStore,
    bytes: &[u8],
    assets_root: &std::path::Path,
) -> Result<LoadedPackage, String> {
    let package = verify_package(trust, bytes, assets_root)?;
    accept_package(trust, &package)?;
    Ok(package)
}

/// [`load_package`] without recording the build: the package is verified as
/// strictly (signature, certificate, revocations, hashes, and its build not
/// older than the highest accepted) and its assets written, but the builds
/// accepted before keep verifying. An embedding app runs it, and once it
/// decided the package is healthy (its first frame drawn, no fatal error for
/// a while) calls [`accept_package`]; if it fails before, the app can go
/// back to the package it ran before, which still verifies.
#[cfg(feature = "js-core")]
pub fn verify_package(
    trust: &nsh_package::TrustStore,
    bytes: &[u8],
    assets_root: &std::path::Path,
) -> Result<LoadedPackage, String> {
    let package = trust
        .verify(bytes, BYTECODE_VERSION)
        .map_err(|e| e.to_string())?;
    let bundle = Bundle::from_package(&package)?;
    let dir = assets_root.join(&package.app.id).join(&package.sha256);
    let done = dir.join(".complete");
    if !done.exists() {
        let assets = dir.join("assets");
        for (path, data) in &package.assets {
            // Paths were checked (relative, no `..`) when the package was read.
            let dest = assets.join(path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&dest, data).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&done, b"").map_err(|e| e.to_string())?;
    }
    Ok(LoadedPackage {
        bundle,
        assets: dir.join("assets"),
        receipt: package.receipt(),
        app: package.app,
    })
}

/// Rewrites every `bundle.js:LINE:COL` in `text` (a reported error and its
/// stack) to the app source position `source_map` (the bundle's) gives,
/// as the engine does with a bundle's own map: for stacks reported by
/// packages published without their map (`nsh symbolicate`).
#[cfg(feature = "js-core")]
pub fn symbolicate(source_map: &str, text: &str) -> String {
    symbolicate::Symbolicator::new(Some(source_map.into())).rewrite(text)
}

/// Records the build of `package` ([`verify_package`]) in `trust`: older
/// builds of its app are refused from now on. Refused if the package or its
/// release key was revoked since it was verified.
#[cfg(feature = "js-core")]
pub fn accept_package(
    trust: &mut nsh_package::TrustStore,
    package: &LoadedPackage,
) -> Result<(), String> {
    trust
        .accept_receipt(&package.receipt)
        .map_err(|e| e.to_string())
}

/// Parses capabilities in their JSON form (`capabilities.json`, the dev
/// protocol, an embedder's grant).
pub fn parse_capabilities(json: &str) -> Result<Capabilities, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("capabilities: {e}"))?;
    Capabilities::from_json(&value)
}

impl Bundle {
    /// The declared capabilities from their JSON form, if any.
    pub fn with_capabilities_json(mut self, json: Option<&str>) -> Result<Self, String> {
        self.policy.declared = json.map(parse_capabilities).transpose()?;
        Ok(self)
    }
}

/// Receives mount batches on the engine thread. Implementations forward
/// them to the UI thread.
pub trait MountSink: Send + 'static {
    /// Called once per commit, in order.
    fn submit(&self, batch: MountBatch);

    /// An error of the app, as text (the message and the stack): the
    /// bundle failed to load, an exception escaped a JS callback, the VM
    /// was stopped. Errors are always logged; development hosts also show
    /// them on screen. What [`MountSink::report`] calls unless it is
    /// implemented.
    fn report_error(&self, _message: &str) {}

    /// An error of the app, with its parts: what went wrong (whether the
    /// app can go on), the message, the stack and the package it came
    /// from. By default, [`MountSink::report_error`] with its text.
    fn report(&self, error: &AppError) {
        self.report_error(&error.to_string());
    }

    /// JS or a component's task asked for a display frame
    /// (`requestAnimationFrame`, `nsh_core::element::next_frame`), or lists have
    /// overscan cells left to bind: call [`EngineControl::frame`] at the
    /// next vsync. Requests are not repeated until that call.
    fn request_frame(&self) {}

    /// A development update ([`EngineControl::hot_update`]) could not be
    /// applied in place: reload the latest full bundle.
    fn hot_update_failed(&self) {}

    /// The engine laid the app out at `size` ([`EngineControl::resize`]):
    /// called after the commit of the turn that applied the resize (if it
    /// changed anything, its batch came before), once per turn, with the
    /// latest size. A platform that waits for the layout at a new size, to
    /// show it in the frame the window takes the size, stops waiting here.
    fn resized(&self, _size: Size<Points>) {}

    /// The engine has handled the first `events` events sent with
    /// [`EngineControl::dispatch_event`]. Called after the commit of the
    /// turn that handled them (what they changed came before), once per
    /// turn. A platform holding typed text for the field an event may focus
    /// gives it to the focused field from here.
    fn handled(&self, _events: u64) {}

    /// The app imports chunk `id` of a split bundle (`import()`), which its
    /// [`Bundle`] does not hold: load it and hand it over with
    /// [`EngineControl::chunk_loaded`] (or [`EngineControl::chunk_failed`]),
    /// from any thread, and return true. False (the default): this host
    /// has no chunks to load, and the import fails.
    fn load_chunk(&self, _id: &str) -> bool {
        false
    }
}

/// Receives what happens to a request started by [`Network::fetch`], in
/// order, on any thread. After [`FetchTask::cancel`] it may still be called
/// (the engine then ignores it).
pub type FetchEvents = Box<dyn FnMut(FetchEvent) + Send>;

/// A request in flight, driven from the engine thread.
pub trait FetchTask: Send {
    /// The next chunk of a streamed body ([`HttpBody::Stream`]), after
    /// [`FetchEvent::BodyWanted`].
    fn send(&mut self, chunk: Vec<u8>);
    /// A streamed body is complete.
    fn finish(&mut self);
    /// Stops (`true`) or resumes (`false`) reading the response body: JS
    /// does not read what arrived (back pressure). Bytes already on their
    /// way may still arrive.
    fn pause(&mut self, paused: bool);
    /// Aborts the request.
    fn cancel(self: Box<Self>);
}

/// The platform's HTTP stack, used by JS `fetch`.
pub trait Network: Send + Sync + 'static {
    /// Starts `request`: its response head, then its body in chunks as they
    /// arrive, are reported to `events`.
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask>;
}

/// Reads the app's bundled files (`asset:/…` URIs): from the app's
/// resources, or from the dev server during development.
pub trait Assets: Send + Sync + 'static {
    /// The bytes of `uri`. Blocking; called on the engine thread.
    fn read(&self, uri: &str) -> Result<Vec<u8>, String>;

    /// Where `asset:/` URIs resolve, when it is a directory or a URL the
    /// image loader can read itself: the core's image loads ([`svg`]s)
    /// then share the platform's cache entries. `None`: through
    /// [`Assets::read`].
    ///
    /// [`svg`]: nsh_core::element::svg
    #[cfg(not(target_arch = "wasm32"))]
    fn base(&self) -> Option<nsh_core::image::loader::AssetBase> {
        None
    }
}

/// Engine settings.
#[derive(Clone)]
pub struct EngineConfig {
    /// The app.
    pub app: App,
    /// Initial size of the root view.
    pub viewport: Size<Points>,
    /// Log per-commit timings (target `nsh::perf`, level info).
    pub trace: bool,
    /// The HTTP stack behind `fetch`; without one, requests fail.
    pub network: Option<Arc<dyn Network>>,
    /// The host transport for WebSockets, including the browser WebSocket API.
    pub websocket: Option<Arc<dyn nsh_core::websocket::WebSocketTransport>>,
    /// Refuses the app's connections (`net` sockets and both WebSocket
    /// APIs) with the error it gives for what they connect to, before they
    /// reach the network: a test's, which reaches it only when the test
    /// asks (`nsh test`'s `network: "live"`). `None`: they connect.
    pub refuse_connections: Option<nsh_core::element::RefuseConnections>,
    /// App-private host filesystem service (for browser storage).
    pub filesystem: Option<Arc<dyn nsh_core::filesystem::FileSystem>>,
    /// Source of bundled files such as fonts; without one, they fail to load.
    pub assets: Option<Arc<dyn Assets>>,
    /// Asynchronously supplies runtime module sources. Configured loaders take
    /// precedence over [`MountSink::load_chunk`]. Native engines share this path.
    #[cfg(not(target_arch = "wasm32"))]
    pub chunk_loader: Option<Arc<dyn ChunkLoader>>,
    /// The surface's initial environment (its `window` is `viewport`).
    pub environment: Environment,
    /// Height of the platform's screen header bar, normal and with a large
    /// title (status bar excluded).
    pub header_heights: (Points, Points),
    /// The JS VM's resource limits (a JS app's; Rust code has none).
    pub limits: Limits,
    /// The UI sets JS imports (`nsh_base::registry()` by default, the app's
    /// own): their Rust components and modules. A Rust app's
    /// components need no registration.
    pub ui_sets: Vec<nsh_core::element::Registry>,
    /// The tokio runtime the components' async tasks use (timers, IO,
    /// background work); `None`: one shared by the engines of the process.
    pub runtime: Option<tokio::runtime::Handle>,
    /// Where apps keep their data: each app in `<data_dir>/<app id>`
    /// ([`App::app_id`]; `default` without one), its storage
    /// (`nsh/storage`) in `storage.json` there. The platform's: the
    /// system's data directory ([`data_dir`]) for apps of their own,
    /// `…/nsh` in an embedding app's. `None`: nothing is kept.
    pub data_dir: Option<std::path::PathBuf>,
    /// Where the app's caches are kept and how much each keeps: the engine
    /// opens them in `<root>/<app id>/<kind>` ([`Engine::image_cache`]).
    /// [`EngineConfig::new`]: none.
    pub cache: CacheOptions,
    /// The app's storage, overriding the one [`EngineConfig::data_dir`]
    /// names (the browser's `localStorage`, an embedder's own); `None`
    /// with no data directory either: in memory, for the engine's life.
    pub storage: Option<Arc<dyn nsh_core::storage::StorageBackend>>,
    /// The time the app runs on: the system's, or a manual clock a test
    /// moves (`nsh_core::time::Clock::manual`), which its timers, frames
    /// and `Date` follow.
    pub clock: Clock,
    /// What the host gives this engine's Rust code, which its UI sets'
    /// functions and components read while it runs them
    /// (`nsh_core::element::engine_context`): a host serving several engines
    /// tells them apart by it.
    pub context: EngineContext,
    /// Values of the environment kept whatever the platform reports (a
    /// test's locale, reduced motion and safe area: `nsh test --target`).
    pub pinned: EnvironmentPins,
    /// Serves the app's clipboard calls in place of the platform's
    /// clipboard (a test's own: `nsh test --target`); `None`: the
    /// platform's.
    pub clipboard: Option<Arc<dyn nsh_core::clipboard::ClipboardBackend>>,
    /// The embedding app's channel with the app (`nsh/host`): its launch
    /// parameters, its events and its handlers of the app's calls and
    /// posts. A view keeps one for every app it runs; the default is a
    /// channel of the engine's own, with none of them.
    pub host: HostChannel,
    /// Answers the app's picks (`Picker.pickImages`) in place of the
    /// platform's picker: the embedding app's own picker, or a test's
    /// files; `None`: the platform's.
    pub picker: Option<Arc<dyn nsh_core::picker::PickerBackend>>,
}

/// Values of the environment an engine keeps whatever its platform reports
/// ([`EngineConfig::pinned`]); `None` leaves the platform's.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub struct EnvironmentPins {
    /// The locale (`Environment::locale`).
    pub locale: Option<nsh_core::platform::Locale>,
    /// Whether the user asked for less motion
    /// (`Environment::reduce_motion`).
    pub reduce_motion: Option<bool>,
    /// The safe area insets (`Environment::safe_area`).
    pub safe_area: Option<nsh_core::geometry::Edges<Points>>,
}

impl EnvironmentPins {
    /// `environment` with these values in place of the platform's.
    pub fn apply(&self, environment: &mut Environment) {
        if let Some(locale) = self.locale {
            environment.locale = locale;
        }
        if let Some(reduce_motion) = self.reduce_motion {
            environment.reduce_motion = reduce_motion;
        }
        if let Some(safe_area) = self.safe_area {
            environment.safe_area = safe_area;
        }
    }
}

fn trusted_directory(path: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    let path = path.filter(|path| path.is_absolute())?;
    nsh_core::access::canonicalize(&path)
        .ok()
        .filter(|path| path.is_dir())
}

/// Native hosts choose these anchors before any application JavaScript runs.
#[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
fn bundle_system_paths(bundle: &Bundle) -> nsh_core::access::TrustedPaths {
    let mut paths = bundle.system_paths.clone();
    paths.plugin_dir = trusted_directory(paths.plugin_dir);
    paths.home_dir = trusted_directory(paths.home_dir);
    if paths.home_dir.is_none() {
        paths.home_dir = ["HOME", "USERPROFILE"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(std::path::PathBuf::from)
            .find_map(|path| trusted_directory(Some(path)));
    }
    // Local `nsh run` passes its canonical entry directory directly to the
    // native child process. Remote dev messages never contain this field.
    // A packaged/hardened bundle cannot inherit a development source anchor.
    if paths.plugin_dir.is_none() && !bundle.policy.harden {
        paths.plugin_dir = std::env::var_os("NSH_DEV_APP_DIR")
            .map(std::path::PathBuf::from)
            .and_then(|path| trusted_directory(Some(path)));
    }
    paths
}

impl EngineConfig {
    /// `app` on a phone-sized surface (390 × 844 points, iOS's header
    /// heights) with nothing else: no network, assets, data directory or
    /// UI sets, the default environment and limits, the shared runtime.
    /// Set the fields that matter over it (`EngineConfig { ui_sets,
    /// ..EngineConfig::new(app) }`). There is no `Default`: an engine has
    /// no app to run by default.
    pub fn new(app: impl Into<App>) -> Self {
        Self {
            app: app.into(),
            viewport: Size::new(Points(390.0), Points(844.0)),
            trace: false,
            network: None,
            websocket: None,
            refuse_connections: None,
            filesystem: None,
            assets: None,
            #[cfg(not(target_arch = "wasm32"))]
            chunk_loader: None,
            environment: Environment::default(),
            header_heights: (Points(44.0), Points(96.0)),
            limits: Limits::default(),
            ui_sets: Vec::new(),
            runtime: None,
            data_dir: None,
            cache: CacheOptions::off(),
            storage: None,
            clock: Clock::system(),
            context: EngineContext::default(),
            pinned: EnvironmentPins::default(),
            clipboard: None,
            host: HostChannel::default(),
            picker: None,
        }
    }
}

/// The storage of the app `config` runs: [`EngineConfig::storage`], or a
/// file in its directory of [`EngineConfig::data_dir`].
fn app_storage(config: &EngineConfig) -> Option<Arc<dyn nsh_core::storage::StorageBackend>> {
    if let Some(storage) = &config.storage {
        return Some(storage.clone());
    }
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(root) = &config.data_dir {
        let dir = root.join(app_dir_name(config.app.app_id()));
        return Some(FileStorage::open(dir));
    }
    None
}

#[cfg(not(target_arch = "wasm32"))]
/// The runtime of components' tasks when the embedder gives none: a few
/// threads, made on first use, shared by every engine (like a thread pool,
/// it holds no engine's state).
fn shared_runtime() -> tokio::runtime::Handle {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("nsh-tasks")
                .enable_all()
                .build()
                .expect("the tasks' runtime starts")
        })
        .handle()
        .clone()
}

impl std::fmt::Debug for EngineConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineConfig")
            .field("app", &self.app)
            .field("viewport", &self.viewport)
            .field("trace", &self.trace)
            .field("network", &self.network.is_some())
            .field("assets", &self.assets.is_some())
            .field("environment", &self.environment)
            .field("header_heights", &self.header_heights)
            .field("limits", &self.limits)
            .field("ui_sets", &self.ui_sets)
            .field("clock", &self.clock)
            .field("context", &self.context)
            .field("pinned", &self.pinned)
            .field("clipboard", &self.clipboard.is_some())
            .field("host", &self.host)
            .field("picker", &self.picker.is_some())
            .finish()
    }
}

/// How many times [`EngineControl::advance_clock`] stops for what comes
/// due at most (sinon's fake timers stop at 1000 for one `runAll`; this
/// leaves room for a long run of 60 Hz intervals).
const MAX_ADVANCE_ROUNDS: usize = 100_000;

enum Message {
    Event(NodeId, EventKind, EventPayload),
    HintObservation(nsh_core::overlay::HintObservation),
    CancelTouch(u32),
    Scroll(NodeId, Point<Points>, u32),
    Kept(Vec<NodeId>),
    InputScroll(NodeId, Point<Points>, Size<Points>, Size<Points>),
    Zoom(NodeId, f32),
    ComponentSize(NodeId, Size<Points>),
    AnimationsFinished(Vec<nsh_core::animation::Finished>),
    Resize(Size<Points>),
    /// A component's task was woken: it runs in the loop.
    Wake,
    Environment(Environment),
    FocusPath(Vec<NodeId>),
    ListCellRetired(NodeId, u64, bool),
    RootSize(NodeId, Size<Points>, EdgeInsets),
    ScreenHeader(NodeId, Option<Points>),
    Frame,
    States(NodeId, u16),
    FontsChanged,
    Remount,
    /// An event of a request (by the hop it is for: events of a hop the
    /// engine left are dropped).
    Fetch(Requester, u64, FetchEvent),
    Hot(HotUpdate),
    /// A chunk [`MountSink::load_chunk`] was asked for, or why it could
    /// not be loaded (its id and the message).
    Chunk(Result<Chunk, (String, String)>),
    Perf(Option<Arc<perf::PerfMonitor>>),
    /// The embedding app's design tokens.
    Tokens(Option<Box<Tokens>>),
    /// The embedding app's event (`nsh/host`'s `host.on`): its name and
    /// data.
    HostEvent(String, nsh_core::JsonValue),
    /// The embedding app's answer to call `.0` (`host.call`).
    HostReply(u64, Result<nsh_core::JsonValue, String>),
    /// The embedding app's URL handler answered URL request `id`: it took
    /// the URL, or the platform opens it.
    UrlHandled {
        id: u32,
        url: String,
        handled: bool,
    },
    /// Moves a manual clock forward by this much, then calls back.
    Advance(std::time::Duration, Box<dyn FnOnce() + Send>),
    /// Sent by a dropped [`Engine`] (there is none in WebAssembly).
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    Shutdown,
}

/// A development update that replaces the app's changed modules in place,
/// keeping the JS context, the views and the state of everything else
/// (made by `nsh_bundler::HotBundle::patch`).
#[derive(Debug, Clone)]
pub struct HotUpdate {
    /// Script name in stack traces, unique per update (e.g. `hot-3.js`).
    pub name: String,
    /// The script.
    pub code: String,
    /// Its source map (JSON).
    pub source_map: Option<Arc<str>>,
}

/// Rounds of "list asks for items -> JS renders them -> layout" folded into
/// one frame. Bounded so a list that never settles cannot stall the engine;
/// leftovers continue next frame.
const MAX_LIST_ROUNDS: usize = 8;

/// The overscan a turn binds: cells until their ops reach this many (about
/// as many mount items, which the main thread applies in one go) or their
/// JS takes [`PACED_BIND_TIME`], at least one. A fast scroll asks for a
/// screen of cells at once and each bind rebuilds a cell's subtree; what
/// shows (the viewport, the leading edge, cells whose item moved) binds
/// regardless, the rest on the next display frames.
const PACED_BIND_OPS: usize = 150;
/// See [`PACED_BIND_OPS`].
const PACED_BIND_TIME: std::time::Duration = std::time::Duration::from_millis(2);

/// A cheap, cloneable handle for sending input to the engine from any thread.
#[derive(Clone)]
pub struct EngineControl {
    tx: Sender<Message>,
}

impl EngineControl {
    /// Forgets this engine's physically cancelled native contact in FIFO order.
    /// Its pending touch point is discarded without invoking handlers or JS jobs;
    /// other contacts retain their queued moves and responders. The platform
    /// separately clears its native pointer capture on the same original load.
    /// A coalesced native activation is conservatively discarded if the
    /// cancelled contact changed in that packet; its owner is not per-contact.
    pub fn cancel_touch(&self, contact: u32) {
        let _ = self.tx.send(Message::CancelTouch(contact));
    }

    /// Delivers an input event (and its data) to a node.
    pub fn dispatch_event(&self, id: NodeId, event: EventKind, payload: EventPayload) {
        let _ = self.tx.send(Message::Event(id, event, payload));
    }

    /// Reports native tooltip presentation without granting input callback
    /// authority. The core revalidates this observation when the same FIFO
    /// consumes it; it never enters ordinary component or JS event routing.
    pub fn observe_hint(&self, observation: nsh_core::overlay::HintObservation) {
        let _ = self.tx.send(Message::HintObservation(observation));
    }

    /// Reports the content offset of a scroll view or list, and how many
    /// scrolls the core asked for (`MountItem::ScrollBy` items and
    /// `Command::ScrollTo` commands for the view) were applied before it.
    /// Cheap to call on every scroll frame: offsets are coalesced per
    /// engine frame.
    pub fn scroll(&self, id: NodeId, offset: Point<Points>, applied: u32) {
        let _ = self.tx.send(Message::Scroll(id, offset, applied));
    }

    /// Keeps the virtual list rows holding `nodes` rendered wherever they
    /// scroll (`Core::set_kept`): the ends of a text selection. Replaces
    /// the last call's; none releases them.
    pub fn keep_rendered(&self, nodes: Vec<NodeId>) {
        let _ = self.tx.send(Message::Kept(nodes));
    }

    /// Reports how far a multiline input's text scrolled: its offset, the
    /// size of the text it scrolls and of its viewport. Sent while a
    /// built-in bar takes the place of its indicator
    /// (`InputConfig::replaced`), on every change.
    pub fn input_scroll(
        &self,
        id: NodeId,
        offset: Point<Points>,
        content: Size<Points>,
        viewport: Size<Points>,
    ) {
        let _ = self
            .tx
            .send(Message::InputScroll(id, offset, content, viewport));
    }

    /// Reports the zoom scale of a zoomable scroll view (before the offset
    /// the zoom changed); `onScroll` carries it.
    pub fn zoom(&self, id: NodeId, scale: f32) {
        let _ = self.tx.send(Message::Zoom(id, scale));
    }

    /// A registered native component's own size (points): it is laid out at
    /// it where its style leaves a dimension open.
    pub fn set_component_size(&self, id: NodeId, size: Size<Points>) {
        let _ = self.tx.send(Message::ComponentSize(id, size));
    }

    /// Reports native animations that finished or were interrupted.
    pub fn animations_finished(&self, finished: Vec<nsh_core::animation::Finished>) {
        let _ = self.tx.send(Message::AnimationsFinished(finished));
    }

    /// Resizes the root view.
    pub fn resize(&self, size: Size<Points>) {
        let _ = self.tx.send(Message::Resize(size));
    }

    /// Reports a change of the surface's environment (safe area, keyboard,
    /// appearance...).
    pub fn set_environment(&self, environment: Environment) {
        let _ = self.tx.send(Message::Environment(environment));
    }

    /// Publishes the terminal's native focus path in FIFO order before
    /// related input or environment messages. This snapshot runs no JS.
    pub fn set_focus_path(&self, path: Vec<NodeId>) {
        let _ = self.tx.send(Message::FocusPath(path));
    }

    /// Answers `MountItem::RetireListCell` only after native input has stopped
    /// targeting that cell, or refuses it while a descendant holds native
    /// focus. Publish that native focus path before a refusal, on this FIFO.
    pub fn retire_list_cell(&self, id: NodeId, request: u64, retired: bool) {
        let _ = self.tx.send(Message::ListCellRetired(id, request, retired));
    }

    /// The platform presents root `id` (a modal) at `size`, with `insets`
    /// of it covered by system UI.
    pub fn set_root_size(&self, id: NodeId, size: Size<Points>, insets: EdgeInsets) {
        let _ = self.tx.send(Message::RootSize(id, size, insets));
    }

    /// The platform measured where the content of screen `id` starts below
    /// its header (`None`: let the core estimate it).
    pub fn set_screen_header(&self, id: NodeId, height: Option<Points>) {
        let _ = self.tx.send(Message::ScreenHeader(id, height));
    }

    /// Applies a development update in place. When it cannot be applied,
    /// [`MountSink::hot_update_failed`] asks the platform to reload.
    pub fn hot_update(&self, update: HotUpdate) {
        let _ = self.tx.send(Message::Hot(update));
    }

    /// Hands over the chunk [`MountSink::load_chunk`] asked for: the
    /// dynamic imports waiting for it continue.
    pub fn chunk_loaded(&self, chunk: Chunk) {
        let _ = self.tx.send(Message::Chunk(Ok(chunk)));
    }

    /// Chunk `id` could not be loaded: the dynamic imports waiting for it
    /// fail with `message` (a later import asks for it again).
    pub fn chunk_failed(&self, id: String, message: String) {
        let _ = self.tx.send(Message::Chunk(Err((id, message))));
    }

    /// A display frame began, after [`MountSink::request_frame`]: runs the
    /// `requestAnimationFrame` callbacks and the tasks waiting for it.
    pub fn frame(&self) {
        let _ = self.tx.send(Message::Frame);
    }

    /// Moves the engine's manual clock ([`EngineConfig::clock`]) forward
    /// by `by`: the timers and tasks due meanwhile run in the order they
    /// come due, each at its time, with what they make due in turn, and the
    /// clock's alarms (a response it holds back) go off on the way. Then
    /// `done` runs, after the batches of what ran were submitted. With the
    /// system's clock it only runs `done`.
    pub fn advance_clock(&self, by: std::time::Duration, done: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Message::Advance(by, Box::new(done)));
    }

    /// Reports the interaction states of view `id` that the core asked to
    /// track ([`nsh_core::MountItem::TrackStates`]; bits of
    /// [`nsh_core::tailwind::state`]). Class styles that depend on them
    /// (`active:`, `hover:`, `focus:`) update without JS.
    pub fn set_states(&self, id: NodeId, states: u16) {
        let _ = self.tx.send(Message::States(id, states));
    }

    /// Fonts the platform loads asynchronously became usable (on the web,
    /// a `FontFace` finished loading): text measured with a fallback font
    /// is measured again.
    pub fn fonts_changed(&self) {
        let _ = self.tx.send(Message::FontsChanged);
    }

    /// The platform's views get everything again and text is measured
    /// again: the unit the platform converts values with changed (Android's
    /// density). Send the new environment and size too.
    pub fn remount(&self) {
        let _ = self.tx.send(Message::Remount);
    }

    /// Records the engine's commits into `monitor` from now on (`None`:
    /// stops). Measuring costs nothing while no monitor is installed.
    pub fn set_perf_monitor(&self, monitor: Option<Arc<perf::PerfMonitor>>) {
        let _ = self.tx.send(Message::Perf(monitor));
    }

    /// Sets the embedding app's design tokens (`nsh-base`'s theme's),
    /// which the app renders with instead of its own (`None`: its own
    /// again; [`Core::set_host_tokens`]). Sent from
    /// [`Engine::start_with`]'s `setup`, they are in the first frame.
    pub fn set_tokens(&self, tokens: Option<Tokens>) {
        let _ = self.tx.send(Message::Tokens(tokens.map(Box::new)));
    }
}

#[cfg(not(target_arch = "wasm32"))]
/// A running engine. Dropping it stops the thread.
pub struct Engine {
    control: EngineControl,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Serializes shutdown with the embedding app's sends.
    host: HostChannel,
    /// Interrupts running JS when the engine stops.
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// The app's disk cache of downloaded images.
    image_cache: Option<nsh_core::image::DiskCache>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Engine {
    /// Starts the engine thread. `make_text_engine` runs on that thread.
    pub fn start<M, F, S>(config: EngineConfig, make_text_engine: F, sink: S) -> io::Result<Engine>
    where
        M: TextEngine + 'static,
        F: FnOnce() -> M + Send + 'static,
        S: MountSink,
    {
        Self::start_with(config, make_text_engine, sink, |_| {})
    }

    /// [`Engine::start`], with `setup` sending input before the engine
    /// starts: what it sends (a theme, the environment) is applied before
    /// the first frame.
    pub fn start_with<M, F, S>(
        config: EngineConfig,
        make_text_engine: F,
        sink: S,
        setup: impl FnOnce(&EngineControl),
    ) -> io::Result<Engine>
    where
        M: TextEngine + 'static,
        F: FnOnce() -> M + Send + 'static,
        S: MountSink,
    {
        let image_cache = config.cache.open_images(config.app.app_id());
        let (tx, rx) = crossbeam_channel::unbounded();
        setup(&EngineControl { tx: tx.clone() });
        let engine_tx = tx.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_stop = stop.clone();
        let host = config.host.clone();
        let thread = std::thread::Builder::new()
            .name("nsh-engine".into())
            .stack_size(ENGINE_STACK_SIZE)
            .spawn(move || run(config, make_text_engine(), sink, engine_tx, rx, engine_stop))?;
        Ok(Engine {
            control: EngineControl { tx },
            thread: Some(thread),
            host,
            stop,
            image_cache,
        })
    }

    /// The disk cache of the images the app downloads
    /// ([`EngineConfig::cache`]; `None`: none). The platform's image loader
    /// routes the app's `http(s)` images through it.
    pub fn image_cache(&self) -> Option<nsh_core::image::DiskCache> {
        self.image_cache.clone()
    }

    /// A handle for sending input from other threads.
    pub fn control(&self) -> EngineControl {
        self.control.clone()
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for Engine {
    fn drop(&mut self) {
        // Dropped on the platform's main thread: a script still running is
        // aborted rather than waited for.
        self.host.shutdown(&self.control.tx, &self.stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
/// The engine thread turns input into frames: it is as latency-critical as
/// the UI thread. Without this, Apple platforms may run it on efficiency
/// cores at low clock speeds.
fn raise_thread_priority() {
    #[cfg(target_vendor = "apple")]
    // SAFETY: changes the QoS class of the calling thread only.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn run<M: TextEngine + 'static, S: MountSink>(
    config: EngineConfig,
    text_engine: M,
    sink: S,
    tx: Sender<Message>,
    rx: Receiver<Message>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    raise_thread_priority();
    // The thread's time is the engine's from its first line of JS on.
    let _clock = config.clock.enter();
    let _context = config.context.enter();
    let Some(mut driver) = Driver::start(config, text_engine, Rc::new(sink), tx, &rx, stop) else {
        return;
    };
    loop {
        let message = match driver.deadline() {
            Some(deadline) => match rx.recv_deadline(deadline) {
                Ok(message) => Some(message),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => None,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            },
        };
        let started = driver.state.perf.is_some().then(Instant::now);
        if let Some(message) = message {
            if !driver.handle(message, &rx) {
                return;
            }
            // Coalesce everything already queued into this frame.
            while let Ok(message) = rx.try_recv() {
                if !driver.handle(message, &rx) {
                    return;
                }
            }
        }
        driver.turn();
        driver.state.record_perf(started);
        if rx.is_empty() {
            driver.collect_if_idle();
        }
    }
}

/// An engine driven by its host's event loop instead of a thread of its
/// own: the browser's main thread in WebAssembly, where there are no
/// threads to block. Input sent through its [`EngineControl`] is handled
/// at the next [`LocalEngine::pump`].
pub struct LocalEngine<M: TextEngine + 'static> {
    /// Dropped while this engine's context is the thread's. The guard
    /// would otherwise end when `drop` returns, before the fields drop.
    driver: ManuallyDrop<Driver<M>>,
    rx: Receiver<Message>,
    control: EngineControl,
    /// The host's wake ([`LocalEngine::set_wake`]).
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Set while [`LocalEngine::pump`] runs: what it wakes it runs itself,
    /// so the host's wake is not called for it.
    pumping: Arc<std::sync::atomic::AtomicBool>,
}

impl<M: TextEngine + 'static> LocalEngine<M> {
    /// Starts the app (its first frame goes to `sink` before this returns);
    /// `None` if it could not start (reported to `sink`).
    pub fn start<S: MountSink>(config: EngineConfig, text_engine: M, sink: S) -> Option<Self> {
        let (tx, rx) = crossbeam_channel::unbounded();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let control = EngineControl { tx: tx.clone() };
        let _clock = config.clock.enter();
        let _context = config.context.enter();
        let driver = Driver::start(config, text_engine, Rc::new(sink), tx, &rx, stop)?;
        Some(LocalEngine {
            driver: ManuallyDrop::new(driver),
            rx,
            control,
            wake: None,
            pumping: Arc::default(),
        })
    }

    /// A handle for sending input.
    pub fn control(&self) -> EngineControl {
        self.control.clone()
    }

    /// Whether queued messages or due timers call for a pump in an otherwise
    /// idle host. This scheduling hint does not consume input or run app code.
    /// Hosts pump after enqueueing native input to deliver its callbacks.
    pub fn needs_pump(&self) -> bool {
        !self.rx.is_empty()
            || self
                .driver
                .deadline()
                .is_some_and(|due| due <= Instant::now())
    }

    /// Calls `wake` when there is work outside a [`pump`](Self::pump): a
    /// component task is woken or Rust posts a JS call while no pump runs
    /// (a callback of the host's completing what a task waits for, such as
    /// a WebSocket message through wasm-bindgen), once per wake-up, or a
    /// pump ends with work its bound left. The host then calls `pump` soon,
    /// instead of only at the deadline it returned or at the next input.
    /// What a pump wakes itself (a task waking another, a reply it hands
    /// over) it runs without calling `wake`.
    pub fn set_wake(&mut self, wake: Arc<dyn Fn() + Send + Sync>) {
        let tx = self.control.tx.clone();
        let pumping = self.pumping.clone();
        let host = wake.clone();
        let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = tx.send(Message::Wake);
            // After the send: a pump that is ending sees the message
            // (`pump` clears the flag, then looks at the queue).
            if !pumping.load(std::sync::atomic::Ordering::SeqCst) {
                host();
            }
        });
        self.driver.state.core.set_task_notify(notify.clone());
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(chunks) = &self.driver.state.chunks {
            chunks.set_notify(notify.clone());
        }
        self.driver.posts.set_notify(notify);
        self.wake = Some(wake.clone());
        if !self.rx.is_empty() {
            wake();
        }
    }

    /// Handles the input sent since the last call, runs what is due
    /// (timers, tasks) and commits. Returns when to call again at the
    /// latest (sooner if input arrives); `None`: only for input.
    pub fn pump(&mut self) -> Option<Instant> {
        let _clock = self.driver.clock.enter();
        let _context = self.driver.context.enter();
        self.pumping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Bounded: messages sent while handling (a task waking another)
        // are handled in the same call, a loop that never settles is not.
        for _ in 0..4 {
            let started = self.driver.state.perf.is_some().then(Instant::now);
            while let Ok(message) = self.rx.try_recv() {
                self.driver.handle(message, &self.rx);
            }
            self.driver.turn();
            self.driver.state.record_perf(started);
            if self.rx.is_empty() {
                break;
            }
        }
        self.driver.collect_if_idle();
        self.pumping
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // What the bound left waits for the next pump: soon, not at the
        // deadline.
        if !self.rx.is_empty()
            && let Some(wake) = &self.wake
        {
            wake();
        }
        self.driver.deadline()
    }
}

impl<M: TextEngine + 'static> Drop for LocalEngine<M> {
    fn drop(&mut self) {
        // Cancelling tasks and dropping what they captured reads this
        // engine's context. `run` keeps its guard across the driver's
        // drop; this path enters for the drop itself.
        let _context = self.driver.context.enter();
        // SAFETY: `driver` is dropped once, here. `ManuallyDrop` keeps
        // the field drop from dropping it again.
        unsafe { ManuallyDrop::drop(&mut self.driver) };
    }
}

/// One engine's state and the work of one wake-up, whoever drives it.
struct Driver<M: TextEngine + 'static> {
    state: State<Rc<M>>,
    script: Option<Script>,
    sink: Rc<dyn MountSink>,
    assets: Option<Arc<dyn Assets>>,
    /// A VM stopped for good (out of memory, over a quota) is reported
    /// once; its views stay as they were and no JS runs any more.
    stopped: bool,
    last_gc: Instant,
    /// When a message or a due timer last gave the engine work
    /// ([`IDLE_GC_QUIET`]).
    last_active: Instant,
    /// The queue of the JS calls Rust posts: its notify wakes the engine,
    /// as the core's task notify does ([`LocalEngine::set_wake`]).
    posts: nsh_core::element::Posts,
    /// The engine's clock, its thread's ([`Clock::enter`]).
    clock: Clock,
    /// The host's context, its thread's ([`EngineContext::enter`]).
    context: EngineContext,
    /// When the last display frame ran, on a clock that moves with the
    /// display's frames: the next one comes a frame after it.
    last_frame: Option<Instant>,
    /// The engine's attachment to the embedding app's channel: its events
    /// come here while the engine runs.
    _host: host_channel::HostAttachment,
}

impl<M: TextEngine + 'static> Driver<M> {
    /// Sets up the core, starts the app and submits its first frame.
    fn start(
        mut config: EngineConfig,
        text_engine: M,
        sink: Rc<dyn MountSink>,
        tx: Sender<Message>,
        rx: &Receiver<Message>,
        stop: Arc<std::sync::atomic::AtomicBool>,
    ) -> Option<Self> {
        config.pinned.apply(&mut config.environment);
        #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
        let system_tx = tx.clone();
        #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
        let host_bridge = config.host.bridge(tx.clone());
        let host_tx = tx.clone();
        let text_engine = Rc::new(text_engine);
        let access = Arc::new(match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            // Native code is trusted: it reaches what the platform allows.
            App::Rust(_) => Policy::default().access(),
        });
        let mut core = Core::new(text_engine.clone(), config.viewport);
        // The runtime's components (`nsh/mobile`'s `TabBar`) and the UI
        // sets the host serves.
        let sets: Vec<_> = nsh_core::runtime::registries()
            .iter()
            .chain(&config.ui_sets)
            .cloned()
            .collect();
        core.set_components(nsh_core::element::Registry::merged(&sets));
        // The JS calls Rust posts queue in one place, which the core
        // releases in order with the ops (a post during a synchronous call)
        // and the script runs.
        let posts = nsh_core::element::Posts::new();
        core.set_posts(posts.clone());
        if let App::Js(_) = &config.app {
            // Only JS is limited (Rust code is as trusted as the platform).
            core.set_max_nodes(config.limits.max_nodes);
        }
        core.set_access(access.clone());
        #[cfg(not(target_arch = "wasm32"))]
        core.set_image_context(nsh_core::image::loader::Context {
            asset_base: config.assets.as_ref().and_then(|a| a.base()),
            read_asset: config.assets.clone().map(|assets| {
                nsh_core::image::loader::ReadAsset::new(move |uri: &str| assets.read(uri))
            }),
            access: access.clone(),
            // The same cache as the platform's ([`Engine::image_cache`]).
            disk: config.cache.open_images(config.app.app_id()),
            // The platform's, if it set one ([`nsh_core::image::loader::set_transport`]).
            transport: None,
        });
        core.set_storage(app_storage(&config));
        core.set_clipboard(config.clipboard.clone());
        core.set_picker(config.picker.clone());
        core.set_font_scale(config.environment.font_scale);
        core.set_class_environment(class_environment(&config.environment));
        core.set_header_heights(config.header_heights.0, config.header_heights.1);
        core.set_safe_area(insets(&config.environment));
        core.set_environment(ui_environment(&config.environment, config.viewport));
        // WebAssembly has no threads for a runtime: tasks' timers are
        // `nsh_core::time`'s there, fired by the driver.
        #[cfg(not(target_arch = "wasm32"))]
        core.set_task_runtime(config.runtime.clone().unwrap_or_else(shared_runtime));
        // A Rust app's theme and fonts come with its root (a JS app's from
        // its bundle).
        if let App::Rust(root) = &config.app {
            if let Some(tokens) = root.tokens_ref() {
                core.set_tokens(tokens.clone());
            }
            if let Some(appearance) = root.appearance_ref() {
                core.set_appearance(appearance);
            }
            for font in root.fonts() {
                if let Err(err) = core.register_font(font) {
                    log::error!("font failed: {err}");
                    sink.report(&AppError::new(
                        AppErrorKind::Asset,
                        &format!("font failed: {err}"),
                    ));
                }
            }
        }
        // The fonts the UI sets' crates ship, before anything is measured.
        let fonts = config
            .ui_sets
            .iter()
            .flat_map(nsh_core::element::Registry::asset_files)
            .filter(|file| file.kind == nsh_core::element::AssetKind::Font);
        for font in fonts {
            let result = match config.assets.as_deref() {
                Some(assets) => assets.read(font.uri),
                None => Err("this host cannot load assets".to_owned()),
            }
            .and_then(|data| core.register_font(&data));
            if let Err(err) = result {
                log::error!("font failed: {}: {err}", font.uri);
                let message = format!("font failed: {}: {err}", font.uri);
                let package = match &config.app {
                    App::Js(bundle) => bundle.package.clone(),
                    App::Rust(_) => None,
                };
                sink.report(&AppError::new(AppErrorKind::Asset, &message).with_package(package));
            }
        }
        // A task woken on any thread wakes the loop, and so does a JS call
        // Rust queues.
        let wake = tx.clone();
        core.set_task_notify(Arc::new(move || {
            let _ = wake.send(Message::Wake);
        }));
        let wake = tx.clone();
        posts.set_notify(Arc::new(move || {
            let _ = wake.send(Message::Wake);
        }));
        // The embedding app's tokens sent before the start
        // (`Engine::start_with`) are there as the bundle evaluates, so its
        // first render reads them; the rest comes after it, in order.
        let mut early = Vec::new();
        while let Ok(message) = rx.try_recv() {
            match message {
                Message::Tokens(tokens) => core.set_host_tokens(tokens.map(|t| *t)),
                message => early.push(message),
            }
        }
        let js_tokens = core.tokens().clone();
        let state = State {
            core,
            js_tokens,
            frame_requested: false,
            ops: Vec::new(),
            binds: Vec::new(),
            events: Vec::new(),
            trace: config.trace,
            perf: None,
            perf_commit: perf::CommitTiming::default(),
            committed_since_gc: false,
            hot: Vec::new(),
            scroll_events: FxHashMap::default(),
            touch_move: None,
            mouse_moves: Vec::new(),
            mouse_moved: None,
            sets_seen: FxHashMap::default(),
            resized: None,
            events_handled: 0,
            events_reported: 0,
            pinned: config.pinned,
            host: config.host.clone(),
            url_opens: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            chunks: config.chunk_loader.clone().map(|loader| {
                chunks::Loads::new(
                    loader,
                    config.runtime.clone().unwrap_or_else(shared_runtime),
                    tx.clone(),
                )
            }),
            net: Net {
                network: config.network.clone(),
                tx,
                queue: NetworkQueue::default(),
                inflight: FxHashMap::default(),
                tasks: Vec::new(),
                abandoned: Vec::new(),
                access: access.clone(),
                hops: 0,
            },
        };

        let mut environment = config.environment;
        environment.window = config.viewport;
        let start = Instant::now();
        let mut driver = Driver {
            state,
            script: None,
            sink: sink.clone(),
            assets: config.assets.clone(),
            stopped: false,
            last_gc: Instant::now(),
            last_active: Instant::now(),
            posts: posts.clone(),
            clock: config.clock.clone(),
            context: config.context.clone(),
            last_frame: None,
            _host: config.host.attach(host_tx, rx.clone()),
        };
        let eval_us = match &config.app {
            App::Js(bundle) => {
                #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
                let system = {
                    script::SystemConfig {
                        access: (*access).clone(),
                        websocket: config.websocket.clone(),
                        refuse_connections: config.refuse_connections.clone(),
                        filesystem: config.filesystem.clone(),
                        data_dir: config
                            .data_dir
                            .as_ref()
                            .map(|root| root.join(app_dir_name(config.app.app_id()))),
                        paths: bundle_system_paths(bundle),
                        wake: Arc::new(move || {
                            let _ = system_tx.send(Message::Wake);
                        }),
                        host: Rc::new(host_bridge),
                    }
                };
                #[cfg(not(any(
                    feature = "js-core",
                    all(feature = "browser", target_arch = "wasm32")
                )))]
                let system = script::SystemConfig;
                let (script, eval_us) = Script::start(
                    bundle,
                    config.limits,
                    &config.ui_sets,
                    posts,
                    &environment,
                    driver.state.js_tokens.clone(),
                    driver.state.core.theme_tokens(),
                    text_engine,
                    stop,
                    sink,
                    system,
                )?;
                driver.script = Some(script);
                eval_us
            }
            App::Rust(root) => {
                driver.state.core.mount_root(root);
                0
            }
        };
        let Driver {
            state,
            script,
            sink,
            assets,
            ..
        } = &mut driver;
        let script = script.as_ref();
        // What was sent before the start (`Engine::start_with`) is in the
        // first frame; a move of the clock comes after it.
        let mut moves = Vec::new();
        let pending = early
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()));
        for message in pending {
            if let Message::Advance(..) = message {
                moves.push(message);
            } else if !handle(script, state, message) {
                return None;
            }
        }
        // Workers may finish while the first bundle evaluates. Deliver their
        // completions even when the startup drain already consumed their wakeup.
        if let Some(script) = script {
            script.run_system();
        }
        state.load_fonts(script, assets.as_deref(), &**sink);
        if let Some(batch) = state.commit(script) {
            if state.trace {
                log::info!(
                    target: "nsh::perf",
                    "first frame: eval {eval_us}µs, total {}µs",
                    start.elapsed().as_micros()
                );
            }
            sink.submit(batch);
        }
        state.report_handled(&**sink);
        state.net.pump(script, &mut state.core);
        state.load_chunks(script, &**sink);
        state.request_frame(script, &**sink);
        driver.check_stopped();
        for message in moves {
            if !driver.handle(message, rx) {
                return None;
            }
        }
        Some(driver)
    }

    /// When the loop wakes next: for the next timer or throttled event
    /// (on the system's clock; a manual one moves only when told), or the
    /// idle collection (the system's time, whatever the clock).
    fn deadline(&self) -> Option<Instant> {
        let gc_deadline =
            (self.script.is_some() && self.state.committed_since_gc).then(|| self.next_gc());
        let due = if self.clock.is_manual() {
            None
        } else {
            self.due()
        };
        [due, gc_deadline].into_iter().flatten().min()
    }

    /// When the next timer, task timer or throttled scroll or mouse move
    /// is due, on the engine's clock.
    fn due(&self) -> Option<Instant> {
        [
            self.script.as_ref().and_then(Script::next_timer),
            self.state.next_scroll_event(),
            self.state.next_mouse_move(),
            self.state.core.next_task_timer(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Handles one message; false on shutdown.
    fn handle(&mut self, message: Message, rx: &Receiver<Message>) -> bool {
        self.last_active = Instant::now();
        match message {
            Message::Advance(by, done) => {
                let running = self.advance(by, rx, self.clock.moves_with_frames());
                done();
                running
            }
            // A test's clock on a real platform: the display's frame moves it
            // to the frame's time first (a frame after the last, else now),
            // as a headless run's frames do.
            Message::Frame if self.clock.moves_with_frames() => {
                // The frame runs there, once, as the frames a move runs on
                // the way do (whatever the messages handled meanwhile do).
                self.state.frame_requested = true;
                let by = self.next_frame() - self.clock.now();
                self.advance(by, rx, true)
            }
            message => handle(self.script.as_ref(), &mut self.state, message),
        }
    }

    /// Moves a manual clock forward by `by` ([`EngineControl::advance_clock`]):
    /// to each time something comes due on the way, running it (and the
    /// messages its alarms sent) before going on; with `frames`, also to
    /// each display frame's time ([`nsh_core::time::FRAME`]) while the app
    /// waits for frames, running the frame there, as a headless run's
    /// display does (a clock that moves with a real display's frames:
    /// [`Clock::with_frames`]). False on shutdown.
    fn advance(&mut self, by: std::time::Duration, rx: &Receiver<Message>, frames: bool) -> bool {
        if !self.clock.is_manual() {
            // What the messages before it did is submitted before `done`.
            self.turn();
            return true;
        }
        let to = self.clock.now() + by;
        for round in 0.. {
            // A timer that keeps scheduling itself at once (`setTimeout(f,
            // 0)` in `f`) would hold the clock at one time for good.
            let frame = (frames && self.state.frame_requested).then(|| self.next_frame());
            let next = [self.due(), self.clock.next_alarm(), frame]
                .into_iter()
                .flatten()
                .min()
                .filter(|&at| at <= to && round < MAX_ADVANCE_ROUNDS);
            if round == MAX_ADVANCE_ROUNDS {
                log::warn!(
                    "the clock ran {MAX_ADVANCE_ROUNDS} rounds of timers without getting there: \
                     a timer keeps scheduling another at once"
                );
            }
            let at = next.unwrap_or(to);
            self.clock.advance_to(at);
            while let Ok(message) = rx.try_recv() {
                if !self.handle(message, rx) {
                    return false;
                }
            }
            // Once: what was handled meanwhile may have run it already.
            if frame.is_some_and(|f| f <= at && self.last_frame.is_none_or(|last| last < f))
                && self.state.frame_requested
            {
                self.frame();
            }
            self.turn();
            if next.is_none() {
                break;
            }
        }
        true
    }

    /// When the next display frame of a clock that moves with the
    /// display's frames is: a frame after the last, at the display's pace
    /// whatever else comes due meanwhile, else (the first, or after a
    /// pause) a frame from now or now.
    fn next_frame(&self) -> Instant {
        let now = self.clock.now();
        self.last_frame
            .map_or(now + nsh_core::time::FRAME, |last| {
                last + nsh_core::time::FRAME
            })
            .max(now)
    }

    /// Runs a display frame of a clock that moves with the display's
    /// frames, now.
    fn frame(&mut self) {
        self.last_frame = Some(self.clock.now());
        handle(self.script.as_ref(), &mut self.state, Message::Frame);
    }

    /// Runs what the handled messages and the time made due, and submits
    /// the frame.
    fn turn(&mut self) {
        let Driver {
            state,
            script,
            sink,
            assets,
            ..
        } = self;
        let script = script.as_ref();
        if script
            .and_then(Script::next_timer)
            .is_some_and(|due| due <= nsh_core::time::now())
        {
            self.last_active = Instant::now();
        }
        let turn_start = state.trace.then(Instant::now);
        state.dispatch_touch_move(script);
        if state
            .next_mouse_move()
            .is_some_and(|due| due <= nsh_core::time::now())
        {
            state.dispatch_mouse_moves(script);
        }
        state.dispatch_scroll_events(script);
        let hot = std::mem::take(&mut state.hot);
        if let Some(script) = script {
            for update in hot {
                script.hot_update(update, &**sink);
            }
            script.run_timers(nsh_core::time::now());
            script.run_system();
        }
        state.core.run_component_tasks();
        // What JS timers and Rust component tasks took; a Rust component
        // renders in the commit.
        let tasks = turn_start.map(|s| s.elapsed());
        state.load_fonts(script, assets.as_deref(), &**sink);
        if let Some(batch) = state.commit(script) {
            sink.submit(batch);
            if let (Some(start), Some(tasks)) = (turn_start, tasks) {
                log::info!(
                    target: "nsh::perf",
                    "turn: {}µs (timers and tasks {}µs)",
                    start.elapsed().as_micros(),
                    tasks.as_micros(),
                );
            }
        }
        if let Some(size) = state.resized.take() {
            sink.resized(size);
        }
        state.report_handled(&**sink);
        state.net.pump(script, &mut state.core);
        state.load_chunks(script, &**sink);
        state.request_frame(script, &**sink);
        self.check_stopped();
    }

    /// When the next idle collection may run: a second after the last, once
    /// the engine has been quiet for [`IDLE_GC_QUIET`] (or at the latest
    /// [`IDLE_GC_LONGEST`] after the last).
    fn next_gc(&self) -> Instant {
        let quiet = (self.last_active + IDLE_GC_QUIET).min(self.last_gc + IDLE_GC_LONGEST);
        (self.last_gc + IDLE_GC_INTERVAL).max(quiet)
    }

    /// Collects cycles when the engine has been idle long enough, so
    /// released nodes free their views.
    fn collect_if_idle(&mut self) {
        if let Some(script) = &self.script
            && self.state.committed_since_gc
            && Instant::now() >= self.next_gc()
        {
            let start = self.state.trace.then(Instant::now);
            script.collect_garbage();
            if let Some(start) = start {
                log::info!(target: "nsh::perf", "gc: {}µs", start.elapsed().as_micros());
            }
            self.last_gc = Instant::now();
            self.state.committed_since_gc = false;
            if let Some(batch) = self.state.commit(Some(script)) {
                self.sink.submit(batch);
            }
        }
    }

    fn check_stopped(&mut self) {
        if let Some(script) = &self.script
            && !self.stopped
            && let Some(reason) = script.fatal()
        {
            self.stopped = true;
            script.report(&*self.sink, AppErrorKind::Stopped, "stopped", &reason);
        }
    }
}

struct ScrollEvent {
    x: f32,
    y: f32,
    content: Size<Points>,
    viewport: Size<Points>,
    /// The zoom scale.
    zoom: f32,
    throttle: Duration,
    last: Option<Instant>,
    /// An offset not reported yet.
    pending: bool,
}

struct State<M: TextEngine> {
    core: Core<M>,
    /// The design tokens JS has (`token()`): the core's when they were
    /// last sent.
    js_tokens: Arc<nsh_core::element::Tokens>,
    /// What the environment keeps whatever the platform reports
    /// ([`EngineConfig::pinned`]).
    pinned: EnvironmentPins,
    /// A display frame was requested and has not begun yet.
    frame_requested: bool,
    ops: Vec<Op>,
    /// List render requests not yet sent to JS.
    binds: Vec<ListBind>,
    /// Events raised by the core (e.g. `onLoadMore`, `onLayout`).
    events: Vec<JsEvent>,
    trace: bool,
    /// Where commit timings go ([`EngineControl::set_perf_monitor`]).
    perf: Option<Arc<perf::PerfMonitor>>,
    /// The core's share of the wake-up being measured (`layout`, `ops`,
    /// `items`; `js` is the rest of the wake-up).
    perf_commit: perf::CommitTiming,
    committed_since_gc: bool,
    /// The embedding app's channel: its URL handler sees the app's URLs
    /// first.
    host: HostChannel,
    /// URLs the app asked to open, taken from the core (a reused buffer).
    url_opens: Vec<(u32, String)>,
    net: Net,
    #[cfg(not(target_arch = "wasm32"))]
    chunks: Option<chunks::Loads>,
    /// Development updates to apply.
    hot: Vec<HotUpdate>,
    /// `onScroll` events: the latest offset per scroll view, sent once per
    /// frame at most (and not more often than the view's throttle).
    scroll_events: FxHashMap<NodeId, ScrollEvent>,
    /// Touch moves not delivered yet: those queued in one frame become one.
    touch_move: Option<(NodeId, Box<nsh_core::TouchEvent>)>,
    /// Mouse moves not delivered yet: the latest per view, in the order they
    /// came; sent once per [`MOUSE_MOVE_INTERVAL`] at most, and before
    /// any other event.
    mouse_moves: Vec<(NodeId, EventPayload)>,
    /// When `mouse_moves` were last delivered.
    mouse_moved: Option<Instant>,
    /// [`keep_last_sets`]'s buffer, reused.
    sets_seen: FxHashMap<(u8, NodeId), usize>,
    /// The viewport size a resize set this turn ([`MountSink::resized`]).
    resized: Option<Size<Points>>,
    /// Events received ([`EngineControl::dispatch_event`]), and the count
    /// last reported ([`MountSink::handled`]).
    events_handled: u64,
    events_reported: u64,
}

/// Who made a request: JS (`fetch`), or a Rust component's task
/// (`nsh_core::element::fetch`, [`Core::take_fetches`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Requester {
    Js(RequestId),
    Task(u32),
}

/// Requests between the app (JS and Rust components' tasks) and the
/// platform's network stack.
struct Net {
    network: Option<Arc<dyn Network>>,
    tx: Sender<Message>,
    queue: NetworkQueue,
    inflight: FxHashMap<Requester, Inflight>,
    /// The tasks' requests taken from the core, and those they gave up
    /// (reused buffers).
    tasks: Vec<(u32, HttpRequest)>,
    abandoned: Vec<u32>,
    /// What the app may reach.
    access: Arc<nsh_core::access::Access>,
    /// Hops started so far (the id of the next).
    hops: u64,
}

/// A request in flight.
struct Inflight {
    task: Box<dyn FetchTask>,
    /// The hop the task is.
    hop: u64,
    /// Requests whose redirects the engine follows (to check each hop).
    followed: Option<access::Followed>,
}

impl Net {
    /// Hands what JS and the components' tasks asked of their requests to
    /// the network.
    fn pump<M: TextEngine>(&mut self, script: Option<&Script>, core: &mut Core<M>) {
        let mut abandoned = std::mem::take(&mut self.abandoned);
        core.take_fetches(&mut self.tasks, &mut abandoned);
        for id in abandoned.drain(..) {
            self.cancel(Requester::Task(id));
        }
        self.abandoned = abandoned;
        let mut tasks = std::mem::take(&mut self.tasks);
        for (id, request) in tasks.drain(..) {
            if let Err(refused) = self.request(Requester::Task(id), request) {
                core.fetch_event(id, FetchEvent::Failed(refused.message));
            }
        }
        self.tasks = tasks;
        let Some(script) = script else { return };
        script.take_network(&mut self.queue);
        for (id, op) in std::mem::take(&mut self.queue.ops) {
            let who = Requester::Js(id);
            match op {
                FetchOp::Start(request) => {
                    if let Err(refused) = self.request(who, request) {
                        script.fetch_refused(id, &refused.message, &refused.url);
                    }
                }
                FetchOp::Send(chunk) => {
                    if let Some(i) = self.inflight.get_mut(&who) {
                        i.task.send(chunk);
                    }
                }
                FetchOp::Finish => {
                    if let Some(i) = self.inflight.get_mut(&who) {
                        i.task.finish();
                    }
                }
                FetchOp::Pause(paused) => {
                    if let Some(i) = self.inflight.get_mut(&who) {
                        i.task.pause(paused);
                    }
                }
                FetchOp::Cancel => self.cancel(who),
            }
        }
    }

    /// Aborts `who`'s request.
    fn cancel(&mut self, who: Requester) {
        if let Some(i) = self.inflight.remove(&who) {
            i.task.cancel();
        }
    }

    /// Makes `who`'s request, if the app may (else why not).
    fn request(&mut self, who: Requester, request: HttpRequest) -> Result<(), access::Refused> {
        if self.access.is_unrestricted() {
            self.start(who, request, None);
        } else if !self.access.allows_http(&request.method, &request.url) {
            return Err(access::refused(&request.method, &request.url));
        } else if request.follow_redirects {
            let hop = access::hop(&request);
            let followed = access::Followed { request, hops: 0 };
            self.start(who, hop, Some(followed));
        } else {
            self.start(who, request, None);
        }
        Ok(())
    }

    /// Hands one request (or redirect hop) to the network.
    fn start(&mut self, id: Requester, request: HttpRequest, followed: Option<access::Followed>) {
        self.hops += 1;
        let hop = self.hops;
        let Some(network) = &self.network else {
            let failed = FetchEvent::Failed("this host has no network stack".to_owned());
            let _ = self.tx.send(Message::Fetch(id, hop, failed));
            return;
        };
        let tx = self.tx.clone();
        let events: FetchEvents = Box::new(move |event| {
            let _ = tx.send(Message::Fetch(id, hop, event));
        });
        let task = network.fetch(request, events);
        self.inflight.insert(
            id,
            Inflight {
                task,
                hop,
                followed,
            },
        );
    }

    /// An event of hop `hop` of request `id`: what JS is told, if anything
    /// (`None` for events of hops left behind, and redirects the engine
    /// follows; `Err` for a redirect the app may not follow).
    fn event(
        &mut self,
        id: Requester,
        hop: u64,
        event: FetchEvent,
    ) -> Option<Result<FetchEvent, access::Refused>> {
        if self.network.is_none() {
            return Some(Ok(event));
        }
        let inflight = self.inflight.get_mut(&id).filter(|i| i.hop == hop)?;
        match event {
            FetchEvent::Head(head) => {
                let Some(followed) = &mut inflight.followed else {
                    return Some(Ok(FetchEvent::Head(head)));
                };
                match access::next(&self.access, followed, head) {
                    access::Next::Done(head) => Some(Ok(FetchEvent::Head(head))),
                    access::Next::Fail(message) => {
                        if let Some(i) = self.inflight.remove(&id) {
                            i.task.cancel();
                        }
                        Some(Ok(FetchEvent::Failed(message)))
                    }
                    access::Next::Refused(refused) => {
                        if let Some(i) = self.inflight.remove(&id) {
                            i.task.cancel();
                        }
                        Some(Err(refused))
                    }
                    access::Next::Hop(request) => {
                        let i = self.inflight.remove(&id)?;
                        let followed = i.followed;
                        i.task.cancel();
                        self.start(id, request, followed);
                        None
                    }
                }
            }
            FetchEvent::End | FetchEvent::Failed(_) => {
                self.inflight.remove(&id);
                Some(Ok(event))
            }
            event => Some(Ok(event)),
        }
    }
}

impl<M: TextEngine> State<M> {
    /// Ends the measured wake-up that began at `started`
    /// ([`EngineControl::set_perf_monitor`]).
    fn record_perf(&mut self, started: Option<Instant>) {
        let (Some(started), Some(monitor)) = (started, &self.perf) else {
            return;
        };
        let busy = started.elapsed();
        monitor.record_busy(busy);
        let mut commit = std::mem::take(&mut self.perf_commit);
        if commit.ops > 0 || commit.items > 0 {
            commit.js = busy.saturating_sub(commit.layout);
            monitor.record_commit(commit);
        }
    }

    fn cancel_touch(&mut self, script: Option<&Script>, contact: u32) {
        if let Some((_, pending)) = &mut self.touch_move {
            if pending
                .points
                .iter()
                .any(|point| point.id == contact && point.changed)
            {
                pending.activated = None;
            }
            pending.points.retain(|point| point.id != contact);
            if !pending.points.iter().any(|point| point.changed) {
                self.touch_move = None;
            }
        }
        self.core.cancel_touch(contact);
        if let Some(script) = script {
            script.cancel_touch(contact);
        }
    }

    fn filter_touch(&mut self, script: Option<&Script>, touch: &mut nsh_core::TouchEvent) {
        let rejected_activation = touch
            .activated
            .is_some_and(|id| !self.core.accepts_native_input(id));
        let invalid: Vec<_> = touch
            .points
            .iter()
            .filter(|point| {
                rejected_activation
                    || point
                        .path
                        .iter()
                        .any(|&id| !self.core.accepts_native_input(id))
            })
            .map(|point| point.id)
            .collect();
        for &contact in &invalid {
            self.cancel_touch(script, contact);
        }
        touch.points.retain(|point| !invalid.contains(&point.id));
        if rejected_activation {
            touch.activated = None;
        }
    }

    /// Source revocation happens before the old native frame disappears.
    /// Forget its queued input and responders before an ACK can permit reuse.
    fn discard_revoked_input(&mut self, script: Option<&Script>) -> bool {
        let core = &self.core;
        self.mouse_moves
            .retain(|(id, _)| core.accepts_native_input(*id));
        self.scroll_events
            .retain(|&id, _| core.accepts_native_input(id));
        self.events.retain(|event| {
            !matches!(event,
            JsEvent::Event(id, _, _) if !core.accepts_native_input(*id))
        });
        let mut contacts = Vec::new();
        core.invalid_touch_contacts(&mut contacts);
        if let Some(script) = script {
            script.invalid_touch_contacts(|id| core.accepts_native_input(id), &mut contacts);
        }
        if let Some((id, touch)) = &self.touch_move {
            let activation_invalid = !core.accepts_native_input(*id)
                || touch
                    .activated
                    .is_some_and(|id| !core.accepts_native_input(id));
            contacts.extend(
                touch
                    .points
                    .iter()
                    .filter(|point| {
                        activation_invalid
                            || point.path.iter().any(|&id| !core.accepts_native_input(id))
                    })
                    .map(|point| point.id),
            );
        }
        contacts.sort_unstable();
        contacts.dedup();
        let cancelled = !contacts.is_empty();
        for contact in contacts {
            self.cancel_touch(script, contact);
        }
        cancelled
    }

    /// Sends the pending touch move.
    fn dispatch_touch_move(&mut self, script: Option<&Script>) {
        self.discard_revoked_input(script);
        if let Some((id, touch)) = self.touch_move.take()
            && let Some(script) = script
        {
            script.dispatch_event(id, EventKind::Touch, &EventPayload::Touch(touch));
        }
    }

    /// When the pending `onMouseMove`s are due.
    fn next_mouse_move(&self) -> Option<Instant> {
        if self.mouse_moves.is_empty() {
            return None;
        }
        Some(
            self.mouse_moved
                .map_or_else(nsh_core::time::now, |t| t + MOUSE_MOVE_INTERVAL),
        )
    }

    /// Delivers the pending `onMouseMove`s: to the Rust components whose
    /// parts they are on, the others to JS.
    fn dispatch_mouse_moves(&mut self, script: Option<&Script>) {
        if self.mouse_moves.is_empty() {
            return;
        }
        self.mouse_moved = Some(nsh_core::time::now());
        for (id, payload) in std::mem::take(&mut self.mouse_moves) {
            if !self.core.accepts_native_input(id) {
                continue;
            }
            if deliver_component_event(
                script,
                &mut self.core,
                &mut self.events,
                id,
                EventKind::MouseMove,
                &payload,
            ) {
                continue;
            }
            if let Some(script) = script {
                script.dispatch_event(id, EventKind::MouseMove, &payload);
            }
        }
    }

    /// When a throttled `onScroll` is due.
    fn next_scroll_event(&self) -> Option<Instant> {
        self.scroll_events
            .values()
            .filter(|e| e.pending)
            .filter_map(|e| e.last.map(|t| t + e.throttle))
            .min()
    }

    /// Sends the `onScroll` events that are due.
    fn dispatch_scroll_events(&mut self, script: Option<&Script>) {
        if self.scroll_events.is_empty() {
            return;
        }
        let now = nsh_core::time::now();
        // Views that stopped listening (or are gone).
        let core = &self.core;
        self.scroll_events
            .retain(|&id, _| core.accepts_native_input(id) && core.scroll_listener(id).is_some());
        for (&id, e) in &mut self.scroll_events {
            if !e.pending || e.last.is_some_and(|t| now < t + e.throttle) {
                continue;
            }
            e.pending = false;
            e.last = Some(now);
            let n = |v: f32| PayloadValue::Number(v as f64);
            let payload = EventPayload::Map(vec![
                (
                    "offset",
                    PayloadValue::Point(geometry::point(Points(e.x), Points(e.y))),
                ),
                ("contentSize", PayloadValue::Size(e.content)),
                ("size", PayloadValue::Size(e.viewport)),
                ("zoomScale", n(e.zoom)),
            ]);
            // A Rust component's scroll view is the component's.
            if !deliver_component_event(
                script,
                &mut self.core,
                &mut self.events,
                id,
                EventKind::Scroll,
                &payload,
            ) && let Some(script) = script
            {
                script.dispatch_event(id, EventKind::Scroll, &payload);
            }
        }
    }

    /// Asks the platform for the chunks JS imports and does not have.
    fn load_chunks(&mut self, script: Option<&Script>, sink: &dyn MountSink) {
        let Some(script) = script else { return };
        let mut ids = Vec::new();
        script.take_chunk_requests(&mut ids);
        for id in ids {
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(chunks) = &mut self.chunks {
                chunks.load(&id);
                continue;
            }
            if !sink.load_chunk(&id) {
                let message = "this host does not load chunks (the app was built split)".to_owned();
                let _ = self.net.tx.send(Message::Chunk(Err((id, message))));
            }
        }
    }

    /// Tells the platform how many events were handled, once the commit
    /// of what they changed is submitted.
    fn report_handled(&mut self, sink: &dyn MountSink) {
        if self.events_handled != self.events_reported {
            self.events_reported = self.events_handled;
            sink.handled(self.events_handled);
        }
    }

    /// Asks the platform for a frame when JS or a component's task waits
    /// for one.
    fn request_frame(&mut self, script: Option<&Script>, sink: &dyn MountSink) {
        if !self.frame_requested
            && (script.is_some_and(Script::wants_frame)
                || self.core.wants_frame()
                || (script.is_some() && self.core.has_paced_list_binds()))
        {
            self.frame_requested = true;
            sink.request_frame();
        }
    }

    /// Registers fonts imported by JS. Blocking: text using them must not be
    /// measured with a fallback font first.
    fn load_fonts(
        &mut self,
        script: Option<&Script>,
        assets: Option<&dyn Assets>,
        sink: &dyn MountSink,
    ) {
        let Some(script) = script else { return };
        let mut fonts = Vec::new();
        script.take_fonts(&mut fonts);
        for uri in fonts {
            let result = match assets {
                Some(assets) => assets.read(&uri),
                None => Err("this host cannot load assets".to_owned()),
            }
            .and_then(|data| self.core.register_font(&data));
            if let Err(err) = result {
                script.report(
                    sink,
                    AppErrorKind::Asset,
                    "font failed",
                    &format!("{uri}: {err}"),
                );
            }
        }
    }

    /// Produces one frame: applies JS ops, lays out, and lets lists pull
    /// the items they need, merging everything into a single batch.
    /// Hands the URLs the app asked to open to the embedding app's URL
    /// handler, or, without one, to the platform ([`nsh_core::open_url`]);
    /// true when the platform has one to open (the core's commit sends it).
    fn open_urls(&mut self) -> bool {
        self.core.take_url_opens(&mut self.url_opens);
        let mut platform = false;
        for (id, url) in self.url_opens.drain(..) {
            if self.host.open_url(id, url.clone(), &self.net.tx).is_none() {
                self.core.open_url_on_platform(id, url);
                platform = true;
            }
        }
        platform
    }

    fn commit(&mut self, script: Option<&Script>) -> Option<MountBatch> {
        let start = Instant::now();
        let mut merged: Option<MountBatch> = None;
        let mut commits = 0;
        let mut op_count = 0;
        let mut js = std::time::Duration::ZERO;
        // The overscan bound this turn ([`PACED_BIND_OPS`]).
        let mut paced = PacedBinds::default();
        for _ in 0..MAX_LIST_ROUNDS {
            // Requests from the previous round (or frame) first.
            let js_start = Instant::now();
            // Without JS, lists bind nowhere (Rust components' lists bind in
            // the core).
            let binds = self.binds.drain(..);
            if let Some(script) = script {
                for mut bind in binds {
                    bind.binds.retain(|&(slot, index)| {
                        self.core.current_list_bind(bind.list, slot, index)
                    });
                    if !bind.binds.is_empty() {
                        script.bind_list(bind.list, &bind.binds);
                    }
                }
                script.take_ops(&mut self.ops);
                // Taking ops publishes JS list sources. Their count/splice
                // must reach the core before its queued indices read them.
                let source_changed = |ops: &[Op]| {
                    ops.iter().any(|op| {
                        matches!(
                            op,
                            Op::SetProp {
                                prop: nsh_core::Prop::Count(_) | nsh_core::Prop::Splice(..),
                                ..
                            } | Op::Release { .. }
                        )
                    })
                };
                let mut source_pending = source_changed(&self.ops);
                let mut binds = Vec::new();
                while !source_pending && paced.left() && self.core.has_paced_list_binds() {
                    let start = Instant::now();
                    let ops = self.ops.len();
                    self.core.take_paced_list_binds(1, &mut binds);
                    for mut bind in binds.drain(..) {
                        bind.binds.retain(|&(slot, index)| {
                            self.core.current_list_bind(bind.list, slot, index)
                        });
                        paced.cells += bind.binds.len();
                        if !bind.binds.is_empty() {
                            script.bind_list(bind.list, &bind.binds);
                        }
                    }
                    script.take_ops(&mut self.ops);
                    source_pending = source_changed(&self.ops[ops..]);
                    paced.ops += self.ops.len() - ops;
                    paced.time += start.elapsed();
                }
            } else {
                drop(binds);
            }
            // The JS calls Rust queued (callbacks' posts), in order, before
            // the events: a task's posts come before its result.
            if let Some(script) = script {
                script.run_posted();
            }
            // The core's events (layouts, ends reached, ...) on a Rust
            // component's nodes are the component's; the rest are JS's, in
            // order with Rust components' events and calls' results.
            for event in self.events.drain(..) {
                match event {
                    JsEvent::Event(id, event, payload) => {
                        if !self.core.accepts_native_input(id) {
                            continue;
                        }
                        if !self.core.component_event(id, event, &payload)
                            && let Some(script) = script
                        {
                            script.dispatch_event(id, event, &payload);
                        }
                    }
                    JsEvent::LayoutListener {
                        host,
                        id,
                        listener,
                        frame,
                    } => {
                        self.core.component_layout(host, id, &listener, frame);
                    }
                    // Without JS nothing waits for them.
                    other => {
                        if let Some(script) = script {
                            script.deliver(other);
                        }
                    }
                }
            }
            if let Some(script) = script {
                script.take_ops(&mut self.ops);
            }
            js += js_start.elapsed();
            op_count += self.ops.len();
            // A stop drops the rest of the ops, releasing what they hold
            // for Rust classes.
            let mut ops = self.ops.drain(..);
            while let Some(op) = ops.next() {
                match self.core.apply(op) {
                    Ok(()) => {}
                    Err(err) if err.is_fatal() => {
                        self.core.discard_ops(ops.by_ref());
                        let Some(script) = script else { break };
                        script.stop(match err {
                            ApplyError::TooManyNodes(max) => {
                                format!("the app created more than {max} nodes and was stopped")
                            }
                            other => {
                                format!("the app sent an invalid op ({other:?}) and was stopped")
                            }
                        });
                        break;
                    }
                    Err(err) => log::error!("invalid op: {err:?}"),
                }
            }
            drop(ops);
            let mut cancelled_input = self.discard_revoked_input(script);
            if let Some(batch) = self.core.commit() {
                commits += 1;
                match &mut merged {
                    Some(m) => extend_frame(&mut m.items, batch.items),
                    None => merged = Some(batch),
                }
            }
            // Rust list sources can change during commit as well. Finish
            // their responder cleanup before a native ACK permits reuse.
            cancelled_input |= self.discard_revoked_input(script);
            self.core.take_list_binds(&mut self.binds);
            self.core.take_events(&mut self.events);
            // URLs the platform opens go out in another round.
            let urls = self.open_urls();
            // Posts the ops queued (in program order) run in another round.
            let posted = script.is_some_and(Script::has_posted);
            // New tokens (the app's theme, the embedding app's) reach what
            // read them in JS, whose ops come in another round.
            let retheme = match script {
                Some(script) if !Arc::ptr_eq(self.core.tokens(), &self.js_tokens) => {
                    self.js_tokens = self.core.tokens().clone();
                    script.set_tokens(self.js_tokens.clone());
                    true
                }
                _ => false,
            };
            let more_paced = script.is_some() && paced.left() && self.core.has_paced_list_binds();
            if self.binds.is_empty()
                && self.events.is_empty()
                && !posted
                && !retheme
                && !more_paced
                && !urls
                && !cancelled_input
            {
                break;
            }
        }
        if commits > 1
            && let Some(batch) = &mut merged
        {
            keep_last_sets(&mut batch.items, &mut self.sets_seen);
        }
        self.committed_since_gc |= op_count > 0;
        if self.perf.is_some() && (op_count > 0 || merged.is_some()) {
            let c = &mut self.perf_commit;
            c.layout += start.elapsed().saturating_sub(js);
            c.ops += op_count as u32;
            c.items += merged.as_ref().map_or(0, |b| b.items.len() as u32);
        }
        if self.trace && (op_count > 0 || merged.is_some()) {
            log::info!(
                target: "nsh::perf",
                "commit: {op_count} ops, {}µs (list js {}µs), {} mount items, {} nodes",
                start.elapsed().as_micros(),
                js.as_micros(),
                merged.as_ref().map_or(0, |b| b.items.len()),
                self.core.node_count(),
            );
        }
        merged
    }
}

fn insets(env: &Environment) -> EdgeInsets {
    env.safe_area
}

/// What Rust components read from the environment.
fn ui_environment(env: &Environment, window: Size<Points>) -> nsh_core::element::Environment {
    nsh_core::element::Environment {
        window,
        safe_area: insets(env),
        title_bar: env.title_bar,
        keyboard_height: env.keyboard_height,
        keyboard_duration: env.keyboard_duration,
        dark: env.color_scheme == ColorScheme::Dark,
        font_scale: env.font_scale,
        reduce_motion: env.reduce_motion,
        screen_reader: env.screen_reader,
        rtl: env.rtl,
        pixel_ratio: env.pixel_ratio,
        os: env.os,
        renderer: env.renderer,
        os_version: env.os_version,
        idiom: env.idiom,
        locale: env.locale,
        apple_keyboard: env.apple_keyboard,
        terminal_keyboard: env.terminal_keyboard,
        host: env.host,
        screen_color: env.screen_color,
        file_requests: env.file_requests,
    }
}

/// What class variants read from the environment.
fn class_environment(env: &Environment) -> nsh_core::tailwind::ClassEnvironment {
    nsh_core::tailwind::ClassEnvironment {
        dark: env.color_scheme == ColorScheme::Dark,
        platform: if env.os == Os::Web {
            nsh_core::tailwind::Platform::Web
        } else if cfg!(target_os = "android") {
            nsh_core::tailwind::Platform::Android
        } else {
            nsh_core::tailwind::Platform::Ios
        },
        reduce_motion: env.reduce_motion,
    }
}

/// Runs a queued native event's full component routing and delivers what
/// that input emitted before a later input or timer can enter JS. Events
/// already waiting in the core retain their ordinary commit ordering.
fn deliver_component_event<M: TextEngine>(
    script: Option<&Script>,
    core: &mut Core<M>,
    pending: &mut Vec<JsEvent>,
    id: NodeId,
    kind: EventKind,
    payload: &EventPayload,
) -> bool {
    if !core.accepts_native_input(id) {
        return true;
    }
    core.take_events(pending);
    let handled = core.component_event(id, kind, payload);
    let mut events = Vec::new();
    core.take_events(&mut events);
    for event in events {
        match event {
            JsEvent::Event(id, kind, payload) => {
                if !deliver_component_event(script, core, pending, id, kind, &payload)
                    && let Some(script) = script
                {
                    script.dispatch_event(id, kind, &payload);
                }
            }
            other => {
                if let Some(script) = script {
                    script.deliver(other);
                }
            }
        }
    }
    handled
}

/// Returns false on shutdown.
fn handle<M: TextEngine>(script: Option<&Script>, state: &mut State<M>, message: Message) -> bool {
    match message {
        Message::HintObservation(observation) => state.core.observe_hint(observation),
        Message::CancelTouch(contact) => state.cancel_touch(script, contact),
        Message::Event(id, event, mut payload) => {
            state.events_handled += 1;
            state.discard_revoked_input(script);
            if !state.core.accepts_native_input(id) {
                return true;
            }
            if let EventPayload::Touch(touch) = &mut payload {
                state.filter_touch(script, touch);
                if !touch.points.iter().any(|point| point.changed) {
                    return true;
                }
            }
            if state.trace {
                log::info!(target: "nsh::perf", "event {event:?} on view {id}");
            }
            // Mouse moves wait for the frame, the latest per view; any other
            // event comes after the moves before it (a view hears where the
            // mouse went before it hears it leave).
            if event == EventKind::MouseMove {
                match state.mouse_moves.iter_mut().find(|(v, _)| *v == id) {
                    Some((_, pending)) => *pending = payload,
                    None => state.mouse_moves.push((id, payload)),
                }
                return true;
            }
            state.dispatch_mouse_moves(script);
            // The core tracks input text for layout and to recognize stale
            // values (from JS and from Rust components alike).
            if let (EventKind::ChangeText, EventPayload::Text { text, count }) = (event, &payload) {
                state.core.input_changed(id, text, *count);
            }
            // The platform knows the caret in the input, the core where
            // the input is.
            if event == EventKind::CaretMove {
                state.core.locate_caret(id, &mut payload);
            }
            if event == EventKind::Paste {
                payload = payload.into_paste();
            }
            // Events on a Rust component's parts are the component's.
            if deliver_component_event(
                script,
                &mut state.core,
                &mut state.events,
                id,
                event,
                &payload,
            ) {
                return true;
            }
            if let EventPayload::Touch(touch) = payload {
                if touch.phase == nsh_core::TouchPhase::Move {
                    match &mut state.touch_move {
                        Some((_, pending)) => pending.merge_move(*touch),
                        None => state.touch_move = Some((id, touch)),
                    }
                    return true;
                }
                // Moves before a start, end or cancel go first.
                state.dispatch_touch_move(script);
                if let Some(script) = script {
                    script.dispatch_event(id, event, &EventPayload::Touch(touch));
                }
                return true;
            }
            let Some(script) = script else { return true };
            let start = state.trace.then(Instant::now);
            script.dispatch_event(id, event, &payload);
            if let Some(start) = start {
                // The handler, its microtasks and the decode of what it
                // committed.
                log::info!(target: "nsh::perf", "event js: {}µs", start.elapsed().as_micros());
            }
        }
        Message::Scroll(id, offset, applied) => {
            if !state.core.accepts_native_input(id) {
                return true;
            }
            state.core.set_scroll_offset(id, offset, applied);
            let (x, y) = (offset.x.0, offset.y.0);
            if let Some((throttle_ms, content, viewport, zoom)) = state.core.scroll_listener(id) {
                let event = state.scroll_events.entry(id).or_insert(ScrollEvent {
                    x,
                    y,
                    content,
                    viewport,
                    zoom,
                    throttle: Duration::from_secs_f32(throttle_ms / 1000.0),
                    last: None,
                    pending: true,
                });
                (event.x, event.y, event.content, event.viewport, event.zoom) =
                    (x, y, content, viewport, zoom);
                event.throttle = Duration::from_secs_f32(throttle_ms / 1000.0);
                event.pending = true;
            }
        }
        Message::Kept(nodes) => state.core.set_kept(&nodes),
        Message::InputScroll(id, offset, content, viewport) => {
            if state.core.accepts_native_input(id) {
                state.core.set_input_scroll(id, offset, content, viewport);
            }
        }
        Message::Zoom(id, scale) => {
            if state.core.accepts_native_input(id) {
                state.core.set_zoom(id, scale);
            }
        }
        Message::ComponentSize(id, size) => {
            if state.core.accepts_native_input(id) {
                state.core.set_component_size(id, size);
            }
        }
        Message::AnimationsFinished(mut finished) => {
            // The components' animations end in the core, JS's in JS.
            state.core.animations_finished(&mut finished);
            if let Some(script) = script {
                script.animations_finished(&finished);
            }
        }
        Message::Resize(size) => {
            state.core.set_viewport(size);
            state.resized = Some(size);
        }
        Message::Wake => {}
        Message::Environment(mut env) => {
            state.pinned.apply(&mut env);
            state.core.set_font_scale(env.font_scale);
            state.core.set_class_environment(class_environment(&env));
            state.core.set_safe_area(insets(&env));
            let window = env.window;
            state.core.set_environment(ui_environment(&env, window));
            if let Some(script) = script {
                script.set_environment(&env);
            }
        }
        Message::FocusPath(mut path) => {
            path.retain(|&id| state.core.accepts_native_input(id));
            state.core.set_focus_path(&path);
            if let Some(script) = script {
                script.set_focus_path(&path);
            }
        }
        Message::ListCellRetired(id, request, retired) => {
            state.discard_revoked_input(script);
            state.core.retire_list_cell(id, request, retired);
        }
        Message::RootSize(id, size, insets) => state.core.set_root_size(id, size, insets),
        Message::ScreenHeader(id, height) => state.core.set_screen_header(id, height),
        Message::Frame => {
            state.frame_requested = false;
            state.core.run_frame(nsh_core::time::now());
            if let Some(script) = script {
                script.run_frame();
            }
        }
        Message::States(id, states) => {
            if state.core.accepts_native_input(id) {
                state.core.set_states(id, states);
            }
        }
        Message::FontsChanged => state.core.fonts_changed(),
        Message::Remount => state.core.remount(),
        Message::Fetch(who, hop, event) => match (who, state.net.event(who, hop, event)) {
            (_, None) => {}
            (Requester::Js(id), Some(event)) => {
                if let Some(script) = script {
                    match event {
                        Ok(event) => script.fetch_event(id, event),
                        Err(refused) => script.fetch_refused(id, &refused.message, &refused.url),
                    }
                }
            }
            (Requester::Task(id), Some(event)) => {
                let event = event.unwrap_or_else(|refused| FetchEvent::Failed(refused.message));
                if !state.core.fetch_event(id, event) {
                    state.net.cancel(who);
                }
            }
        },
        Message::Hot(update) => state.hot.push(update),
        Message::Chunk(chunk) => {
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(chunks) = &mut state.chunks {
                chunks.finished(match &chunk {
                    Ok(chunk) => &chunk.id,
                    Err((id, _)) => id,
                });
            }
            if let Some(script) = script {
                script.chunk(chunk);
            }
        }
        Message::Perf(monitor) => {
            state.perf = monitor;
            state.perf_commit = perf::CommitTiming::default();
        }
        Message::Tokens(tokens) => {
            state.core.set_host_tokens(tokens.map(|t| *t));
            if let Some(script) = script {
                script.set_theme_tokens(state.core.theme_tokens());
            }
        }
        // A Rust app has no `nsh/host`: what the host sends it goes.
        Message::HostEvent(name, data) => {
            if let Some(script) = script {
                script.host_event(&name, data);
            }
        }
        Message::HostReply(id, result) => {
            if let Some(script) = script {
                script.host_reply(id, result);
            }
        }
        Message::UrlHandled { id, url, handled } => {
            if handled {
                state.core.answer_open_url(id, true);
            } else {
                state.core.open_url_on_platform(id, url);
            }
        }
        // The driver handles it ([`Driver::handle`]), and keeps the ones
        // sent before it started for after the first frame.
        Message::Advance(..) => unreachable!("the driver moves the clock"),
        Message::Shutdown => return false,
    }
    true
}

/// What a turn spent binding overscan cells.
#[derive(Default)]
struct PacedBinds {
    cells: usize,
    ops: usize,
    time: std::time::Duration,
}

impl PacedBinds {
    /// Whether the turn may bind another: at least one, then within the
    /// budget.
    fn left(&self) -> bool {
        self.cells == 0 || (self.ops < PACED_BIND_OPS && self.time < PACED_BIND_TIME)
    }
}

/// Appends a commit's items to the frame's. A scroll view's content size
/// that the frame already sets is updated to the later size (unless the
/// view scrolls in between): a row relaid over two commits must not send
/// the platform a transient size, which clamps the offset before the
/// content grows back (a list jumping when a row expands).
fn extend_frame(frame: &mut Vec<nsh_core::MountItem>, items: Vec<nsh_core::MountItem>) {
    use nsh_core::MountItem;
    let start = frame.len();
    frame.extend(items);
    for k in start..frame.len() {
        let MountItem::ScrollContent { id, size } = frame[k] else {
            continue;
        };
        let earlier = frame[..k].iter().rposition(|m| {
            matches!(m, MountItem::ScrollContent { id: e, .. } | MountItem::ScrollBy { id: e, .. } if *e == id)
        });
        if let Some(j) = earlier
            && let MountItem::ScrollContent { size: s, .. } = &mut frame[j]
        {
            *s = size;
        }
    }
}

/// Of the items of a frame merged from several commits that set one part
/// of a view whole (its frame, style, text, ...), keeps the last: the
/// platform would apply each in one pass, and a list's rounds (binds, then
/// the paced ones) relay and restyle the same cells. Once per turn, with
/// `last` the reused buffer.
fn keep_last_sets(frame: &mut Vec<nsh_core::MountItem>, last: &mut FxHashMap<(u8, NodeId), usize>) {
    last.clear();
    let mut repeated = false;
    for (k, item) in frame.iter().enumerate() {
        if let Some(key) = sets_whole(item) {
            repeated |= last.insert(key, k).is_some();
        }
    }
    if !repeated {
        return;
    }
    let mut k = 0;
    frame.retain(|item| {
        k += 1;
        sets_whole(item).is_none_or(|key| last[&key] == k - 1)
    });
}

/// The part of a view an item sets whole, and the view: of two such items
/// the later is all the view ends up with.
fn sets_whole(item: &nsh_core::MountItem) -> Option<(u8, nsh_core::NodeId)> {
    use nsh_core::MountItem;
    Some(match *item {
        MountItem::Frame { id, .. } => (0, id),
        MountItem::Overflow { id, .. } => (1, id),
        MountItem::ViewStyle { id, .. } => (2, id),
        MountItem::Text { id, .. } => (3, id),
        MountItem::Events { id, .. } => (4, id),
        MountItem::Image { id, .. } => (5, id),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn pinned_values_hold_whatever_the_platform_reports() {
        let pins = super::EnvironmentPins {
            locale: nsh_core::platform::Locale::parse("de-DE"),
            reduce_motion: Some(true),
            ..Default::default()
        };
        let mut reported = super::Environment {
            locale: nsh_core::platform::Locale::parse("en-US").unwrap(),
            font_scale: 1.5,
            ..Default::default()
        };
        pins.apply(&mut reported);
        assert_eq!(reported.locale.as_str(), "de-DE");
        assert!(reported.reduce_motion);
        // What is not pinned stays the platform's.
        assert_eq!(reported.font_scale, 1.5);
        assert_eq!(reported.safe_area, Default::default());
    }

    #[test]
    fn bundle_default_has_no_application_selected_path_anchors() {
        let bundle = super::Bundle::default();
        assert!(bundle.system_paths.plugin_dir.is_none());
        assert!(bundle.system_paths.home_dir.is_none());
        assert!(matches!(bundle.code, super::BundleCode::Source(ref code) if code.is_empty()));
    }

    #[test]
    fn bundle_trusted_paths_reject_relative_and_missing_directories() {
        let mut paths = nsh_core::access::TrustedPaths::default();
        paths.plugin_dir = Some(std::path::PathBuf::from("relative-app"));
        paths.home_dir = Some(std::path::PathBuf::from("relative-home"));
        let bundle = super::Bundle::default().with_system_paths(paths);
        assert!(bundle.system_paths.plugin_dir.is_none());
        assert!(bundle.system_paths.home_dir.is_none());
        assert!(
            super::trusted_directory(Some(std::path::PathBuf::from(
                "/nsh-nonexistent-anchor-never-created"
            )))
            .is_none()
        );
    }

    #[test]
    fn local_bundle_anchors_its_canonical_parent_without_metadata_authority() {
        let root = std::env::var_os("TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var_os("HOME").expect("HOME"))
                    .join(".cache/nsh-benchs-test-tmp")
            });
        assert!(root.is_absolute() && !root.starts_with("/tmp"));
        let directory = root.join(format!("nsh-bundle-anchors-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bundle.js");
        std::fs::write(&path, "export default null;").unwrap();
        let bundle = super::Bundle::read(&path).unwrap();
        assert_eq!(
            bundle.system_paths.plugin_dir,
            Some(nsh_core::access::canonicalize(&directory).unwrap())
        );
        assert!(bundle.system_paths.home_dir.is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rust_environment_preserves_native_title_bar_insets() {
        use super::{Edges, Points};
        let title_bar = Edges {
            top: Points(42.0),
            left: Points(78.0),
            right: Points(138.0),
            bottom: Points(0.0),
        };
        let environment = super::Environment {
            title_bar,
            ..Default::default()
        };
        assert_eq!(
            super::ui_environment(
                &environment,
                nsh_core::Size::new(Points(840.0), Points(630.0))
            )
            .title_bar,
            title_bar
        );
    }

    #[test]
    fn rust_environment_preserves_the_terminal_renderer() {
        let environment = super::Environment {
            os: super::Os::MacOs,
            renderer: super::Renderer::Terminal,
            ..Default::default()
        };
        let ui = super::ui_environment(
            &environment,
            nsh_core::Size::new(Points(960.0), Points(640.0)),
        );
        assert_eq!(ui.os, super::Os::MacOs);
        assert_eq!(ui.renderer, super::Renderer::Terminal);
    }

    use nsh_core::{MountItem, Points, Size};

    #[test]
    fn local_readiness_observes_pending_input_due_timers_and_idle_without_running_them() {
        use nsh_core::{ApproxTextEngine, EventKind, EventPayload, prelude::*};

        use super::{EngineConfig, LocalEngine, MountSink, Root};

        #[component]
        fn Readiness() -> impl IntoElement {
            let value = signal(0);
            view()
                .on_press(move |_: &()| {
                    value.set(1);
                    set_timeout(std::time::Duration::from_secs(1), move || value.set(2));
                })
                .child(text(move || format!("Readiness {}", value.get())))
        }
        struct Sink(crossbeam_channel::Sender<nsh_core::MountBatch>);
        impl MountSink for Sink {
            fn submit(&self, batch: nsh_core::MountBatch) {
                self.0.send(batch).unwrap();
            }
        }
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut engine = LocalEngine::start(
            EngineConfig::new(Root::of::<Readiness>()),
            ApproxTextEngine,
            Sink(tx),
        )
        .unwrap();
        engine.pump();
        let first = rx.try_recv().unwrap();
        let text = |batch: &nsh_core::MountBatch| {
            batch
                .items
                .iter()
                .filter_map(|item| match item {
                    MountItem::Text { text, .. } => Some(text.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(text(&first), ["Readiness 0"]);
        assert!(!engine.needs_pump());
        let button = first
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .unwrap();
        engine
            .control()
            .dispatch_event(button, EventKind::Press, EventPayload::None);
        assert!(engine.needs_pump());
        assert!(engine.needs_pump());
        assert!(
            rx.try_recv().is_err(),
            "probing does not handle the queued press"
        );
        let due = engine.pump().expect("the pressed component has a timer");
        assert_eq!(text(&rx.try_recv().unwrap()), ["Readiness 1"]);
        assert!(
            !engine.needs_pump(),
            "a future timer does not need an idle pump"
        );
        std::thread::sleep(due.saturating_duration_since(nsh_core::time::Instant::now()));
        assert!(engine.needs_pump());
        assert!(engine.needs_pump());
        assert!(rx.try_recv().is_err(), "probing does not run the due timer");
        engine.pump();
        assert_eq!(text(&rx.try_recv().unwrap()), ["Readiness 2"]);
        assert!(!engine.needs_pump());
    }

    #[cfg(feature = "js")]
    #[test]
    fn queued_component_events_deliver_all_listeners_and_preserve_their_emits() {
        use std::cell::Cell;

        use nsh_core::{ApproxTextEngine, EventKind, EventPayload, prelude::*};

        use super::{Bundle, EngineConfig, LocalEngine, MountSink};

        thread_local! {
            static LATER: Cell<u32> = const { Cell::new(0) };
        }
        #[derive(Event)]
        enum Pressed {
            Press,
        }
        #[component]
        fn Forward(cx: Scope<Pressed>) -> impl IntoElement {
            view()
                .test_id("forward")
                .on_press(cx.forward(Pressed::Press))
                .on_press(|_: &()| LATER.with(|later| later.set(later.get() + 1)))
        }
        #[component]
        fn Business(cx: Scope<Pressed>) -> impl IntoElement {
            view()
                .test_id("business")
                .on_press(move |_: &()| cx.emit(Pressed::Press))
                .on_press(|_: &()| LATER.with(|later| later.set(later.get() + 1)))
        }
        struct Sink(crossbeam_channel::Sender<nsh_core::MountBatch>);
        impl MountSink for Sink {
            fn submit(&self, batch: nsh_core::MountBatch) {
                self.0.send(batch).unwrap();
            }
        }
        let mut registry = Registry::ui_set("test/queued");
        registry.register::<Forward>().register::<Business>();
        let sets = vec![nsh_base::registry(), registry];
        let descriptions = sets.iter().map(Into::into).collect::<Vec<_>>();
        let source = nsh_bundler::compile_module(
            "queued.tsx",
            r#"import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Forward, Business } from "test/queued";
const rendered = signal("");
let sequence = 0;
const report = value => rendered.set(`${++sequence}:${value}`);
mount(() => <View>
  <Button testID="button" onPress={() => report("button")} />
  <Forward onPress={() => report("forward")} />
  <Business onPress={() => report("business")} />
  <Text>{rendered()}</Text>
</View>);"#,
            &descriptions,
        )
        .unwrap();
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut engine = LocalEngine::start(
            EngineConfig {
                ui_sets: sets,
                ..EngineConfig::new(Bundle::source(source))
            },
            ApproxTextEngine,
            Sink(tx),
        )
        .unwrap();
        let first = rx.try_recv().unwrap();
        let node = |name| {
            first
                .items
                .iter()
                .find_map(|item| match item {
                    MountItem::ViewProps { id, props }
                        if props.test_id.as_deref() == Some(name) =>
                    {
                        Some(*id)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("missing {name}: {:?}", first.items))
        };
        let (button, forward, business) = (node("button"), node("forward"), node("business"));
        let rendered = || {
            rx.try_iter()
                .flat_map(|batch| batch.items)
                .filter_map(|item| match item {
                    MountItem::Text { text, .. } => Some(text.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let control = engine.control();
        for phase in [EventKind::PressDown, EventKind::PressUp] {
            control.dispatch_event(button, phase, EventPayload::None);
        }
        engine.pump();
        assert!(rendered().is_empty());

        control.dispatch_event(button, EventKind::Press, EventPayload::None);
        engine.pump();
        assert_eq!(rendered(), ["1:button"]);

        control.dispatch_event(button, EventKind::Press, EventPayload::None);
        control.dispatch_event(forward, EventKind::Press, EventPayload::None);
        assert_eq!(LATER.with(Cell::get), 0, "callbacks wait for the pump");
        engine.pump();
        assert_eq!(rendered(), ["3:forward"]);
        assert_eq!(LATER.with(Cell::get), 1);

        control.dispatch_event(business, EventKind::Press, EventPayload::None);
        engine.pump();
        assert_eq!(rendered(), ["4:business"], "Rust callback emits reach JS");
        assert_eq!(LATER.with(Cell::get), 2);

        control.dispatch_event(forward, EventKind::Press, EventPayload::None);
        engine.pump();
        assert_eq!(rendered(), ["5:forward"]);
        assert_eq!(LATER.with(Cell::get), 3, "every Rust listener runs once");
    }

    #[cfg(feature = "js")]
    #[test]
    fn queued_component_and_js_inputs_keep_fifo_before_timers_in_one_frame() {
        use nsh_core::{ApproxTextEngine, EventKind, EventPayload};

        use super::{Bundle, EngineConfig, LocalEngine, MountSink};

        struct Sink(crossbeam_channel::Sender<nsh_core::MountBatch>);
        impl MountSink for Sink {
            fn submit(&self, batch: nsh_core::MountBatch) {
                self.0.send(batch).unwrap();
            }
        }
        let registry = nsh_base::registry();
        let source = nsh_bundler::compile_module(
            "queued-input.tsx",
            r#"import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
const output = signal("");
const record = value => output.set(output() ? `${output()},${value}` : value);
mount(() => <View>
  <Button testID="button" onPress={() => record("button")} />
  <View testID="shortcut" onPress={() => record("shortcut")} />
  <View testID="arm" onPress={() => {
    output.set("");
    setTimeout(() => record("timer"), 0);
  }} />
  <Text>{output()}</Text>
</View>);"#,
            &[(&registry).into()],
        )
        .unwrap();
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut engine = LocalEngine::start(
            EngineConfig {
                ui_sets: vec![registry],
                ..EngineConfig::new(Bundle::source(source))
            },
            ApproxTextEngine,
            Sink(tx),
        )
        .unwrap();
        let first = rx.try_recv().unwrap();
        let node = |name| {
            first
                .items
                .iter()
                .find_map(|item| match item {
                    MountItem::ViewProps { id, props }
                        if props.test_id.as_deref() == Some(name) =>
                    {
                        Some(*id)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        let (button, shortcut, arm) = (node("button"), node("shortcut"), node("arm"));
        let control = engine.control();
        let press = |node| control.dispatch_event(node, EventKind::Press, EventPayload::None);
        let frame = || {
            let frames = rx.try_iter().collect::<Vec<_>>();
            assert_eq!(frames.len(), 1, "one pump produces one completed frame");
            frames
                .into_iter()
                .flat_map(|batch| batch.items)
                .filter_map(|item| match item {
                    MountItem::Text { text, .. } => Some(text.text.clone()),
                    _ => None,
                })
                .next_back()
                .unwrap()
        };
        press(button);
        press(shortcut);
        engine.pump();
        assert_eq!(frame(), "button,shortcut");

        press(arm);
        press(shortcut);
        press(button);
        engine.pump();
        assert_eq!(frame(), "shortcut,button,timer");

        press(arm);
        press(button);
        engine.pump();
        assert_eq!(
            frame(),
            "button,timer",
            "the final input precedes due timers too"
        );
    }

    #[cfg(feature = "js")]
    #[test]
    fn cancelling_one_native_contact_keeps_the_other_move_without_responder_callbacks() {
        use nsh_core::{
            ApproxTextEngine, Command, EventKind, EventPayload, MountItem, Points, ROOT_ID,
            TouchEvent, TouchPhase, TouchPoint,
        };

        use super::{Bundle, EngineConfig, LocalEngine, MountSink};

        struct Sink(crossbeam_channel::Sender<nsh_core::MountBatch>);
        impl MountSink for Sink {
            fn submit(&self, batch: nsh_core::MountBatch) {
                self.0.send(batch).unwrap();
            }
        }
        let source = nsh_bundler::compile_module(
            "cancel-contact.tsx",
            r#"import { mount, signal, Text, View } from "nsh";
const log = signal("");
const record = value => log.set(`${log()}${value}|`);
mount(() => <View>
  <View testID="pad"
    onStartShouldSetResponder={() => true}
    onResponderGrant={() => { record("grant"); return true; }}
    onTouchMove={event => record(`move:${event.changedTouches.map(p => p.identifier).join(",")}`)}
    onResponderMove={() => record("responder-move")}
    onResponderTerminate={() => record("terminate")}
    onResponderRelease={() => record("release")} />
  <View testID="probe" onPress={() => record("probe")} />
  <Text>{`log ${log()}`}</Text>
</View>);"#,
            &[],
        )
        .unwrap();
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut engine = LocalEngine::start(
            EngineConfig::new(Bundle::source(source)),
            ApproxTextEngine,
            Sink(tx),
        )
        .unwrap();
        let first = rx.try_recv().unwrap();
        let node = |name| {
            first
                .items
                .iter()
                .find_map(|item| match item {
                    MountItem::ViewProps { id, props }
                        if props.test_id.as_deref() == Some(name) =>
                    {
                        Some(*id)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        let (pad, probe) = (node("pad"), node("probe"));
        let control = engine.control();
        let touch = |phase, contacts: &[(u32, bool)]| {
            control.dispatch_event(
                ROOT_ID,
                EventKind::Touch,
                EventPayload::Touch(Box::new(TouchEvent {
                    phase,
                    timestamp: 0.0,
                    activated: None,
                    points: contacts
                        .iter()
                        .map(|&(id, changed)| TouchPoint {
                            id,
                            target: pad,
                            path: if phase == TouchPhase::Start {
                                vec![pad]
                            } else {
                                Vec::new()
                            },
                            page: nsh_core::geometry::point(Points(20.0), Points(20.0)),
                            location: nsh_core::geometry::point(Points(20.0), Points(20.0)),
                            changed,
                        })
                        .collect(),
                })),
            );
        };
        let frame = || {
            let items = rx
                .try_iter()
                .flat_map(|batch| batch.items)
                .collect::<Vec<_>>();
            let log = items
                .iter()
                .rev()
                .find_map(|item| match item {
                    MountItem::Text { text, .. } if text.text.starts_with("log ") => {
                        Some(text.text.clone())
                    }
                    _ => None,
                })
                .expect("a positive output fence");
            (log, items)
        };
        touch(TouchPhase::Start, &[(1, true)]);
        touch(TouchPhase::Start, &[(1, false), (2, true)]);
        engine.pump();
        assert_eq!(frame().0, "log grant|");

        touch(TouchPhase::Move, &[(1, true), (2, true)]);
        control.cancel_touch(1);
        control.cancel_touch(1);
        control.cancel_touch(99);
        engine.pump();
        assert_eq!(frame().0, "log grant|move:2|responder-move|");

        control.cancel_touch(2);
        control.dispatch_event(probe, EventKind::Press, EventPayload::None);
        engine.pump();
        let (log, items) = frame();
        assert_eq!(log, "log grant|move:2|responder-move|probe|");
        assert!(items.iter().any(|item| matches!(
            item,
            MountItem::Command {
                id: ROOT_ID,
                command: Command::ClearJsResponder
            }
        )));

        touch(TouchPhase::Start, &[(3, true)]);
        touch(TouchPhase::End, &[(3, true)]);
        engine.pump();
        assert_eq!(
            frame().0,
            "log grant|move:2|responder-move|probe|grant|release|"
        );
    }

    #[test]
    fn a_frame_sends_a_scroll_views_last_content_size() {
        let content = |height| MountItem::ScrollContent {
            id: 2,
            size: Size::new(Points(390.0), height),
        };
        let heights = |frame: &[MountItem]| -> Vec<f32> {
            frame
                .iter()
                .filter_map(|m| match m {
                    MountItem::ScrollContent { size, .. } => Some(size.height.0),
                    _ => None,
                })
                .collect()
        };
        let mut frame = vec![content(Points(313.0))];
        super::extend_frame(&mut frame, vec![content(Points(544.0))]);
        assert_eq!(heights(&frame), [544.0, 544.0]);
        // A scroll in between keeps the size it scrolled against.
        let mut frame = vec![
            content(Points(313.0)),
            MountItem::ScrollBy {
                id: 2,
                dx: Points(0.0),
                dy: Points(10.0),
            },
        ];
        super::extend_frame(&mut frame, vec![content(Points(544.0))]);
        assert_eq!(heights(&frame), [313.0, 544.0]);
    }

    #[test]
    fn a_frame_sends_a_views_last_frame_once() {
        use nsh_core::{Bounds, Point};
        let at = |id, y| MountItem::Frame {
            id,
            frame: Bounds::new(
                Point::new(Points(0.0), Points(y)),
                Size::new(Points(10.0), Points(10.0)),
            ),
        };
        let mut frame = vec![
            MountItem::Create {
                id: 4,
                kind: nsh_core::ViewKind::View,
            },
            at(4, 0.0),
            at(6, 0.0),
        ];
        super::extend_frame(&mut frame, vec![at(4, 50.0)]);
        super::keep_last_sets(&mut frame, &mut Default::default());
        assert!(matches!(frame[0], MountItem::Create { id: 4, .. }));
        let frames: Vec<_> = frame
            .iter()
            .filter_map(|m| match m {
                MountItem::Frame { id, frame } => Some((*id, frame.origin.y.0)),
                _ => None,
            })
            .collect();
        assert_eq!(frames, [(6, 0.0), (4, 50.0)]);
    }
}
