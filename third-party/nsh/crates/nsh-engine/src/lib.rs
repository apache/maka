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
#[cfg_attr(not(feature = "shader"), path = "shader_off.rs")]
pub mod shader;
mod shader_frame;
#[cfg(all(feature = "shader", target_vendor = "apple"))]
mod shader_surfaces;
#[cfg(not(target_arch = "wasm32"))]
mod storage;
#[cfg(feature = "js-core")]
mod symbolicate;
#[cfg(all(feature = "js-core", not(target_arch = "wasm32")))]
pub mod updates;

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
    PayloadValue, TextEngine, element::JsEvent, platform::content_type, time::Instant,
};
pub use nsh_core::{
    JsonValue,
    access::{Access, Capabilities},
    element::{EngineContext, Root, Tokens},
    geometry::{self, Bounds, Edges, Point, Points, Size},
    js::{HostLimits, Limits},
    main_thread::MainThreadTask,
    platform::{
        ColorScheme, Environment, FetchEvent, FetchOp, HostEnvironment, HourCycle, HttpBody,
        HttpHead, HttpRequest, Idiom, Languages, Lifecycle, Locale, LocaleSettings,
        MeasurementSystem, Os, TemperatureUnit, TimeZone, Weekday,
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

    /// The main window's launch options (`nsh.json` `"window"`): a JS app's
    /// bundle's ([`Bundle::main_window`]), a Rust app's root's
    /// ([`nsh_core::element::Root::main_window`]). Runners open the main
    /// window by them.
    pub fn main_window(&self) -> Option<&nsh_core::desktop::MainWindowOptions> {
        match self {
            App::Rust(root) => root.main_window_ref(),
            App::Js(bundle) => bundle.main_window.as_ref(),
        }
    }

    /// The URL schemes the app claims (`nsh.json` `schemes`):
    /// the links the core lets through (`nsh_core::url_scheme`).
    pub fn url_schemes(&self) -> &[String] {
        match self {
            App::Rust(root) => root.url_schemes_ref(),
            App::Js(bundle) => &bundle.url_schemes,
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
    /// The URL schemes the app claims (`nsh.json` `schemes`, a
    /// packaged app's `app.json`): the links its engine lets through.
    /// Read from the app's own resources, never from its code; none for a
    /// signed package, whose embedding app owns the schemes.
    pub url_schemes: Vec<String>,
    /// Trusted filesystem anchors selected by the native host, never decoded
    /// from application code, its manifest or a development server message.
    /// Missing anchors deny relative and corresponding placeholder grants.
    pub system_paths: nsh_core::access::TrustedPaths,
    /// The signed package the bundle came from ([`Bundle::from_package`]),
    /// named in the app's errors ([`AppError::package`]).
    pub package: Option<Arc<PackageInfo>>,
    /// The update configuration `nsh/updater` reads (`nsh-updater.json`,
    /// as `nsh package` wrote it), from the installed app's own resources;
    /// `None`: the file among the app's assets, if any. A packaged app
    /// running a newer package of its code sets the shipped one
    /// (`updates::launch`).
    pub updater_config: Option<Arc<[u8]>>,
    /// Told how the app fares, while it has not proved it runs: a package
    /// of a packaged app's code running for the first time
    /// (`updates::launch`).
    pub trial: Option<Arc<dyn Trial>>,
    /// The main window's launch-time options (`nsh.json` `"window"`, an
    /// app's `app.json`, the dev server's app info): runners read them
    /// before they make the window; the engine sends their attributes to
    /// the main window with the first frame.
    pub main_window: Option<nsh_core::desktop::MainWindowOptions>,
}

/// How long an app on [`Bundle::trial`] runs past its first frame without
/// a fatal error to be healthy.
pub const TRIAL_PERIOD: Duration = Duration::from_secs(10);

/// A run on trial ([`Bundle::trial`]): the engine tells it once whether
/// the app is healthy or failed (later calls are its to ignore). A crash
/// of the process tells it nothing.
pub trait Trial: Send + Sync + std::fmt::Debug + 'static {
    /// The app ran [`TRIAL_PERIOD`] past its first frame, or its engine
    /// stopped after the first frame, without a fatal error.
    fn healthy(&self);
    /// The app did not start, or its VM was stopped ([`AppError::is_fatal`]).
    fn failed(&self, error: &AppError);
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
            url_schemes: Vec::new(),
            system_paths: nsh_core::access::TrustedPaths::default(),
            package: None,
            updater_config: None,
            trial: None,
            main_window: None,
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
            url_schemes: Vec::new(),
            system_paths: nsh_core::access::TrustedPaths::default(),
            package: None,
            updater_config: None,
            trial: None,
            main_window: None,
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

    /// The main window's launch-time options from their JSON (`nsh.json`
    /// `"window"`, as the dev server's app info carries it); a wrong one is
    /// logged and left out.
    pub fn with_main_window(mut self, json: Option<&str>) -> Self {
        self.main_window = json.and_then(|json| {
            let parsed = serde_json::from_str(json)
                .map_err(|e| e.to_string())
                .and_then(|v| nsh_core::desktop::MainWindowOptions::from_json(&v));
            parsed.map_err(|e| log::warn!("nsh.json window: {e}")).ok()
        });
        self
    }

    /// The URL schemes the app claims ([`Bundle::url_schemes`]), as
    /// `nsh.json` gives them.
    pub fn with_url_schemes(
        mut self,
        schemes: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.url_schemes = schemes.into_iter().map(Into::into).collect();
        self
    }

    /// Attaches a source map.
    pub fn with_source_map(mut self, map: impl Into<Arc<str>>) -> Self {
        self.source_map = Some(map.into());
        self
    }

    /// Sets the URL relative request URLs resolve against: the page's, for
    /// an app on a web page. A base marks a page: with one, a media source
    /// `/x` is the page's path, not a local file under `capabilities.fs`
    /// ([`nsh_core::access::Access::media_url`]), so a native host sets none.
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
    /// `bundle.js.map`, the app's `capabilities.json`, its id and the
    /// schemes it claims (`app.json` `"id"` and `"schemes"`) next to it
    /// if present. Bytecode (`bundle.nshc`) is refused: files can be replaced, and
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
        let info = read_app_json(&path.with_file_name("app.json"));
        bundle.app_id = info
            .as_ref()
            .and_then(|info| info.get("id")?.as_str().map(str::to_owned));
        if let Some(window) = info.as_ref().and_then(|info| info.get("window")) {
            bundle.main_window = Some(
                nsh_core::desktop::MainWindowOptions::from_json(window)
                    .map_err(|e| io::Error::other(format!("app.json: {e}")))?,
            );
        }
        if let Some(url_schemes) = info.as_ref().and_then(|info| info.get("schemes")) {
            // A newer NSH's: what this runtime cannot claim is left out.
            let (schemes, ignored) = nsh_core::url_scheme::schemes_from_json_lenient(url_schemes);
            for what in ignored {
                log::warn!("app.json: {what}, ignored");
            }
            bundle.url_schemes = schemes;
        }
        // The files it opens come as `file:` URLs (`nsh_core::file_type`).
        if info
            .as_ref()
            .is_some_and(nsh_core::file_type::declares_file_types)
        {
            bundle
                .url_schemes
                .push(nsh_core::file_type::FILE_SCHEME.to_owned());
        }
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

/// An `app.json` (`nsh build`'s, a packaged app's): the app's id, the
/// schemes it claims.
fn read_app_json(path: &std::path::Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
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
/// protocol, an embedder's grant). A newer NSH may have written them: what
/// this runtime does not know is not granted (a warning says what), so a
/// bundle built by a newer toolchain still runs here and never gets more
/// than it declared.
pub fn parse_capabilities(json: &str) -> Result<Capabilities, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("capabilities: {e}"))?;
    let (capabilities, dropped) = Capabilities::from_json_lenient(&value)?;
    for dropped in dropped {
        log::warn!("not granted: {dropped} (unknown to this NSH)");
    }
    Ok(capabilities)
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

    /// Include logical tree order when the mounted structure changes. Native
    /// `Insert` items alone describe stacking order, which can differ by `zIndex`.
    fn needs_tree_order(&self) -> bool {
        false
    }

    /// Include the states views show as parts of a control
    /// ([`nsh_core::MountItem::ProjectStates`]): for a platform that marks
    /// a list's highlighted option itself, as a terminal does.
    fn needs_projected_states(&self) -> bool {
        false
    }

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

    /// Runs `task` on the UI thread, after the batches submitted before it
    /// (`nsh_core::element::run_on_main_thread`). By default it runs here,
    /// on the engine thread: what a host without a main thread of its own
    /// does (headless tests, the web, where the engine runs on the page's
    /// thread).
    fn run_on_main_thread(&self, task: MainThreadTask) {
        task.run();
    }

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

/// `nsh/updater` on the engine's network and assets: the platform's HTTP stack
/// (so its TLS and proxies), and the file `nsh package` left among the assets.
struct UpdaterOverNetwork {
    network: Arc<dyn Network>,
    assets: Option<Arc<dyn Assets>>,
    /// [`Bundle::updater_config`].
    config: Option<Arc<[u8]>>,
    /// [`Bundle::package`].
    running: Option<Arc<PackageInfo>>,
}

impl UpdaterOverNetwork {
    /// `None` without a network, or without both assets and the bundle's
    /// configuration (nothing to update from).
    #[cfg_attr(
        not(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32"))),
        allow(dead_code)
    )]
    fn host(
        network: Option<Arc<dyn Network>>,
        assets: Option<Arc<dyn Assets>>,
        bundle: &Bundle,
    ) -> Option<Arc<dyn nsh_core::runtime::UpdaterHost>> {
        if assets.is_none() && bundle.updater_config.is_none() {
            return None;
        }
        Some(Arc::new(UpdaterOverNetwork {
            network: network?,
            assets,
            config: bundle.updater_config.clone(),
            running: bundle.package.clone(),
        }))
    }
}

impl nsh_core::runtime::UpdaterHost for UpdaterOverNetwork {
    fn config(&self) -> Option<Vec<u8>> {
        if let Some(config) = &self.config {
            return Some(config.to_vec());
        }
        // Only a package has it; a dev server answers nothing for it.
        self.assets.as_ref()?.read("asset:/nsh-updater.json").ok()
    }

    fn running_package(&self) -> Option<nsh_core::runtime::PackageVersion> {
        let running = self.running.as_ref()?;
        let mut version = nsh_core::runtime::PackageVersion::default();
        version.version = running.version.clone();
        version.build = running.build;
        Some(version)
    }

    fn runs_packages(&self) -> bool {
        cfg!(all(feature = "js-core", not(target_arch = "wasm32")))
    }

    #[cfg(all(feature = "js-core", not(target_arch = "wasm32")))]
    fn verify_package(
        &self,
        file: &std::path::Path,
        updates: &std::path::Path,
        app_id: &str,
        roots: &[String],
        newer_than: u64,
    ) -> Result<nsh_core::runtime::PackageVersion, String> {
        let app = updates::verify_download(file, updates, app_id, roots, newer_than)?;
        let mut version = nsh_core::runtime::PackageVersion::default();
        version.version = app.version;
        version.build = app.build;
        Ok(version)
    }

    fn get(&self, url: &str, sink: nsh_core::runtime::UpdaterSink<'_>) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let events: FetchEvents = Box::new(move |event| {
            let _ = tx.send(event);
        });
        let task = self.network.fetch(HttpRequest::new("GET", url), events);
        let mut total = None;
        let result = loop {
            match rx.recv() {
                Ok(FetchEvent::Head(head)) => {
                    if !(200..300).contains(&head.status) {
                        break Err(format!("HTTP {}", head.status));
                    }
                    total = head
                        .headers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.parse().ok());
                }
                Ok(FetchEvent::Data(chunk)) => {
                    if let Err(e) = sink(&chunk, total) {
                        break Err(e);
                    }
                }
                Ok(FetchEvent::End) => return Ok(()),
                Ok(FetchEvent::Failed(e)) => break Err(e),
                Ok(FetchEvent::BodyWanted) => {}
                Err(_) => break Err("the network stack went away".to_owned()),
            }
        };
        task.cancel();
        result
    }
}

/// The platform's HTTP stack, used by JS `fetch`.
pub trait Network: Send + Sync + 'static {
    /// Starts `request`: its response head, then its body in chunks as they
    /// arrive, are reported to `events`.
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask>;
}

/// Reads the app's bundled files (`asset:/…` URIs): from the app's
/// resources, or from the dev server during development. The engine reads
/// the fonts it registers with it, and answers the app's requests of
/// `asset:/` URLs (`fetch`) from it.
pub trait Assets: Send + Sync + 'static {
    /// The bytes of `uri`. Blocking: the engine calls it on its thread for
    /// the fonts it registers, and on a thread of the runtime's blocking
    /// pool for the app's requests (in WebAssembly on its thread).
    fn read(&self, uri: &str) -> Result<Vec<u8>, String>;

    /// Where `uri` is served, for files [`Assets::read`] does not have at
    /// hand: the engine downloads them from there with its network stack
    /// (the web page, which holds only the files it preloaded). `None`, the
    /// default, when `read` is the only way.
    fn url(&self, uri: &str) -> Option<String> {
        let _ = uri;
        None
    }

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
    /// Scroll views make the native views of their content only near
    /// their viewport (the platforms' apps); off, they make all of it
    /// (tests, which read whole pages). [`EngineConfig::new`]: off.
    pub content_culling: bool,
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
    /// Answers the app's picks (`Picker.pickImages`, `Picker.pickFiles`) in place of the
    /// platform's picker: the embedding app's own picker, or a test's
    /// files; `None`: the platform's.
    pub picker: Option<Arc<dyn nsh_core::picker::PickerBackend>>,
    /// Recognizes the app's speech (`Speech.start`) instead of the
    /// platform's recognizer: the embedding app's own, or a test's fake
    /// (`nsh_testing`'s). `None` (the default): the platform's, where it
    /// has one (`Environment::speech`).
    pub speech: Option<Arc<dyn nsh_core::speech::SpeechBackend>>,
    /// Plays the app's sound (`Sound`, `AudioPlayer`) instead of the
    /// platform: the embedding app's own audio stack, or a test's fake
    /// (`nsh_testing`'s). `None` (the default): the platform's, where it
    /// has one (`Environment::audio`).
    pub audio: Option<Arc<dyn nsh_core::audio::AudioBackend>>,
    /// Opens and applies the app's windows of its own (`<Window>`,
    /// `Window.open`) instead of the platform: the embedding app's own
    /// windows, or a test's fake. `None` (the default): the platform's
    /// built-in backend, which every desktop backend has, embedded or
    /// standalone. The main window's commands always go to the platform.
    pub windows: Option<Arc<dyn nsh_core::desktop::WindowBackend>>,
}

/// Values of the environment an engine keeps whatever its platform reports
/// ([`EngineConfig::pinned`]); `None` leaves the platform's.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub struct EnvironmentPins {
    /// The locale (`Environment::locale`).
    pub locale: Option<nsh_core::platform::Locale>,
    /// The preferred languages (`LocaleSettings::languages`).
    pub languages: Option<nsh_core::platform::Languages>,
    /// The hour cycle (`LocaleSettings::hour_cycle`).
    pub hour_cycle: Option<nsh_core::platform::HourCycle>,
    /// The first day of the week (`LocaleSettings::first_day_of_week`).
    pub first_day_of_week: Option<nsh_core::platform::Weekday>,
    /// The measurement system (`LocaleSettings::measurement_system`).
    pub measurement_system: Option<nsh_core::platform::MeasurementSystem>,
    /// The temperature unit (`LocaleSettings::temperature_unit`).
    pub temperature_unit: Option<nsh_core::platform::TemperatureUnit>,
    /// The time zone (`LocaleSettings::time_zone`).
    pub time_zone: Option<nsh_core::platform::TimeZone>,
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
        let settings = &mut environment.locale_settings;
        if let Some(languages) = self.languages {
            settings.languages = languages;
        }
        if let Some(time_zone) = self.time_zone {
            settings.time_zone = time_zone;
        }
        if let Some(hour_cycle) = self.hour_cycle {
            settings.hour_cycle = hour_cycle;
        }
        if let Some(day) = self.first_day_of_week {
            settings.first_day_of_week = day;
        }
        if let Some(system) = self.measurement_system {
            settings.measurement_system = system;
        }
        if let Some(unit) = self.temperature_unit {
            settings.temperature_unit = unit;
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

/// Native hosts choose these anchors before any application JavaScript runs
/// (the VM's `fs/promises` and the core's media files read under them).
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
            content_culling: false,
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
            speech: None,
            audio: None,
            windows: None,
        }
    }

    /// Where a runner opens the main window of an app with nsh.json
    /// `window.restoreBounds`: the placement its last run kept in its
    /// storage ([`EngineConfig::storage`], or the file in its directory of
    /// [`EngineConfig::data_dir`]), fitted on `displays`, the ones there
    /// are now. Read before making the window; `None` without
    /// `restoreBounds` or a kept placement. The engine keeps it as the
    /// window changes (the environment's window state).
    pub fn main_window_placement(
        &self,
        displays: &[nsh_core::desktop::Display],
    ) -> Option<nsh_core::desktop::WindowPlacement> {
        let options = self.app.main_window()?;
        let storage = app_storage(self)?;
        options.kept_placement(&*storage, displays)
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
            .field("content_culling", &self.content_culling)
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
            .field("speech", &self.speech.is_some())
            .field("audio", &self.audio.is_some())
            .field("windows", &self.windows.is_some())
            .finish()
    }
}

/// How many times [`EngineControl::advance_clock`] stops for what comes
/// due at most (sinon's fake timers stop at 1000 for one `runAll`; this
/// leaves room for a long run of 60 Hz intervals).
const MAX_ADVANCE_ROUNDS: usize = 100_000;

/// How many times [`EngineControl::flush`] runs what is queued again when
/// running it queued more (a task woken by another, a request answered at
/// once): a task that keeps waking itself leaves the engine busy.
const MAX_FLUSH_ROUNDS: usize = 64;

enum Message {
    Event(NodeId, EventKind, EventPayload),
    Scroll(NodeId, Point<Points>, u32),
    Kept(Vec<NodeId>),
    ContentCulling(bool),
    InputScroll(NodeId, Point<Points>, Size<Points>, Size<Points>),
    Zoom(NodeId, f32),
    ComponentSize(NodeId, Size<Points>),
    AnimationsFinished(Vec<nsh_core::animation::Finished>),
    Resize(Size<Points>),
    /// A component's task was woken: it runs in the loop.
    Wake,
    /// Boxed: with the locale settings held inline, an
    /// environment is several times the size of every other message, and
    /// it changes rarely.
    Environment(Box<Environment>),
    FocusPath(Vec<NodeId>),
    /// The platform found no GPU to draw shader views with
    /// ([`EngineControl::shaders_unavailable`]).
    ShadersUnavailable,
    /// The displays (desktops).
    Displays(Arc<[nsh_core::desktop::Display]>),
    RootSize(NodeId, Size<Points>, EdgeInsets),
    ScreenHeader(NodeId, Option<Points>),
    Frame,
    States(NodeId, u16),
    Modality(nsh_core::platform::InputModality),
    FontsChanged,
    Remount,
    /// An event of a request (by the hop it is for: events of a hop the
    /// engine left are dropped).
    Fetch(Requester, u64, FetchEvent),
    /// Hop `.1` of the request `.2` for a bundled file read it on a
    /// blocking thread ([`Net::asset`]): its bytes, or why there are none.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    AssetRead(Requester, u64, HttpRequest, Result<Vec<u8>, String>),
    Hot(HotUpdate),
    /// A chunk [`MountSink::load_chunk`] was asked for, or why it could
    /// not be loaded (its id and the message).
    Chunk(Result<Chunk, (String, String)>),
    Perf(Option<Arc<perf::PerfMonitor>>),
    /// The embedding app's design tokens.
    Tokens(Option<Box<Tokens>>),
    /// A font file the embedding app registers (TrueType, OpenType, WOFF or
    /// WOFF2), before the first frame and whenever it registers another.
    HostFont(Vec<u8>),
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
    /// Runs what is queued and due now, then calls back with whether the
    /// engine is idle ([`EngineControl::flush`]).
    Flush(Box<dyn FnOnce(bool) + Send>),
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
    events_sent: Arc<std::sync::atomic::AtomicU64>,
    /// The input modality last sent ([`Self::set_input_modality`]), shared
    /// by every clone: 0 none, else 1 + the modality.
    modality: Arc<std::sync::atomic::AtomicU8>,
}

impl EngineControl {
    /// Delivers an input event (and its data) to a node.
    pub fn dispatch_event(&self, id: NodeId, event: EventKind, payload: EventPayload) {
        self.events_sent
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        if self.tx.send(Message::Event(id, event, payload)).is_err() {
            self.events_sent
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
    }

    /// Events queued through [`Self::dispatch_event`], matching [`MountSink::handled`].
    pub fn events_sent(&self) -> u64 {
        self.events_sent.load(std::sync::atomic::Ordering::Acquire)
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

    /// Whether scroll views make the native views of their content as it
    /// comes near their viewport (the default), or all of it
    /// (`Core::set_content_culling`): a test driver's, whose steps reach
    /// every view of a page.
    pub fn set_content_culling(&self, enabled: bool) {
        let _ = self.tx.send(Message::ContentCulling(enabled));
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
        let _ = self.tx.send(Message::Environment(Box::new(environment)));
    }

    /// The platform has no GPU to draw shader views with
    /// ([`shader::Renderer::new`] is `None`): the app's
    /// `Environment::shaders` turns `false` now and stays so, whatever the
    /// platform reports later. Telling it again does nothing.
    pub fn shaders_unavailable(&self) {
        let _ = self.tx.send(Message::ShadersUnavailable);
    }

    /// Reports the displays (desktops: on start, in
    /// [`Engine::start_with`]'s setup, so the app reads them as it first
    /// renders, then whenever they change).
    pub fn set_displays(&self, displays: Vec<nsh_core::desktop::Display>) {
        let _ = self.tx.send(Message::Displays(displays.into()));
    }

    /// Publishes the native focus path in FIFO order before related input or
    /// environment messages. This snapshot runs no JS.
    pub fn set_focus_path(&self, path: Vec<NodeId>) {
        let _ = self.tx.send(Message::FocusPath(path));
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

    /// Runs everything sent to the engine before it and everything due on
    /// its clock now (timers, woken tasks, answers that came at once), with
    /// what they queue in turn, without moving the clock. Then `done` runs,
    /// after the batches of what ran were submitted, with whether the
    /// engine is idle: nothing is left to run and no request waits for
    /// the network. False when work keeps coming (a task that keeps waking
    /// itself) or a request is in flight, whose answer comes later from
    /// elsewhere. A headless driver on a manual clock settles a step with
    /// it, instead of waiting for the batches to stop for a while.
    pub fn flush(&self, done: impl FnOnce(bool) + Send + 'static) {
        let _ = self.tx.send(Message::Flush(Box::new(done)));
    }

    /// The user gave the surface input with `modality`: a pointer, finger
    /// or pen going down, or a key pressed (not a modifier alone). Called
    /// for every such event, before the platform acts on it, so it reaches
    /// the core ahead of the focus move it causes; only a change crosses
    /// to the engine. The core shows the keyboard focus by it
    /// (`focus-visible:`; [`nsh_core::Core::set_input_modality`]).
    pub fn set_input_modality(&self, modality: nsh_core::platform::InputModality) {
        use std::sync::atomic::Ordering;
        let code = match modality {
            nsh_core::platform::InputModality::Keyboard => 1,
            nsh_core::platform::InputModality::Pointer => 2,
        };
        if self.modality.swap(code, Ordering::Relaxed) != code {
            let _ = self.tx.send(Message::Modality(modality));
        }
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

    /// Registers a font file the embedding app ships (TrueType, OpenType,
    /// WOFF or WOFF2) so every app this engine runs can name its family.
    /// Sent from [`Engine::start_with`]'s `setup`, it is registered before
    /// the first frame; sent later, text measured already is measured again.
    pub fn register_font(&self, data: Vec<u8>) {
        let _ = self.tx.send(Message::HostFont(data));
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
    /// The app has quit listeners (`on_app_quit`, `Application.on("quit")`):
    /// a drop gives them [`QUIT_TIMEOUT`] before interrupting JS.
    quit_listeners: Arc<std::sync::atomic::AtomicBool>,
    /// The app's disk cache of downloaded images.
    image_cache: Option<nsh_core::image::DiskCache>,
    /// [`Engine::media_files`].
    media_files: Arc<nsh_core::access::MediaFiles>,
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
        let media_files = Arc::new(media_files(&config, &app_access(&config.app)));
        let (tx, rx) = crossbeam_channel::unbounded();
        let control = EngineControl {
            tx: tx.clone(),
            events_sent: Arc::default(),
            modality: Arc::default(),
        };
        setup(&control);
        let engine_tx = tx;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_stop = stop.clone();
        let quit_listeners = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_quit_listeners = quit_listeners.clone();
        let host = config.host.clone();
        let thread = std::thread::Builder::new()
            .name("nsh-engine".into())
            .stack_size(ENGINE_STACK_SIZE)
            .spawn(move || {
                run(
                    config,
                    make_text_engine(),
                    sink,
                    engine_tx,
                    rx,
                    engine_stop,
                    engine_quit_listeners,
                )
            })?;
        Ok(Engine {
            control,
            thread: Some(thread),
            host,
            stop,
            quit_listeners,
            image_cache,
            media_files,
        })
    }

    /// The roots the app's local media files are read under
    /// ([`nsh_core::access::MediaFiles::open`]). The platform's image
    /// loader reads `<Image>` files through them, as the core's does, so a
    /// link swapped in after the check is not followed out of them.
    pub fn media_files(&self) -> Arc<nsh_core::access::MediaFiles> {
        self.media_files.clone()
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
        // aborted rather than waited for, after the app's quit listeners
        // had their time (GPUI's shutdown waits for its quit observers so).
        if self
            .quit_listeners
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.host.request_shutdown(&self.control.tx);
            let deadline = Instant::now() + QUIT_TIMEOUT + QUIT_GRACE;
            while self.thread.as_ref().is_some_and(|t| !t.is_finished())
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
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

/// How long the engine runs the app's quit listeners at most.
#[cfg(not(target_arch = "wasm32"))]
use nsh_core::element::desktop::QUIT_TIMEOUT;

/// What the dropping [`Engine`] waits past [`QUIT_TIMEOUT`] for the engine
/// to finish its last turn before interrupting JS.
#[cfg(not(target_arch = "wasm32"))]
const QUIT_GRACE: Duration = Duration::from_millis(20);

/// A resize this soon after the last is one of a burst, a window being
/// dragged; this long after the last the burst is over ([`Core::set_resizing`]).
const RESIZE_BURST_GAP: Duration = Duration::from_millis(120);

#[cfg(not(target_arch = "wasm32"))]
fn run<M: TextEngine + 'static, S: MountSink>(
    config: EngineConfig,
    text_engine: M,
    sink: S,
    tx: Sender<Message>,
    rx: Receiver<Message>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    quit_listeners: Arc<std::sync::atomic::AtomicBool>,
) {
    raise_thread_priority();
    // The thread's time is the engine's from its first line of JS on.
    let _clock = config.clock.enter();
    let _context = config.context.enter();
    let Some(mut driver) = Driver::start(config, text_engine, Rc::new(sink), tx, &rx, stop) else {
        return;
    };
    driver.quit_listeners = quit_listeners;
    driver.sync_quit_listeners();
    drive(&mut driver, &rx);
    driver.quit(&rx);
    // Stopped on purpose (a crash never gets here): a trial is over.
    if let Some(trial) = &driver.trial {
        trial.healthy();
    }
}

/// Tells `trial` the app is healthy [`TRIAL_PERIOD`] after its first frame
/// (it ignores this after a fatal error).
fn start_trial(trial: Arc<dyn Trial>) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let spawned = std::thread::Builder::new()
            .name("nsh-trial".into())
            .spawn(move || {
                std::thread::sleep(TRIAL_PERIOD);
                trial.healthy();
            });
        if let Err(err) = spawned {
            log::error!("cannot time the app's trial: {err}");
        }
    }
    // WebAssembly runs no packaged apps' updates.
    #[cfg(target_arch = "wasm32")]
    drop(trial);
}

/// Runs the engine's loop until it stops.
#[cfg(not(target_arch = "wasm32"))]
fn drive<M: TextEngine + 'static>(driver: &mut Driver<M>, rx: &Receiver<Message>) {
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
            if !driver.handle(message, rx) {
                return;
            }
            // Coalesce everything already queued into this frame.
            while let Ok(message) = rx.try_recv() {
                if !driver.handle(message, rx) {
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
    #[cfg(not(target_arch = "wasm32"))]
    image_cache: Option<nsh_core::image::DiskCache>,
    media_files: Arc<nsh_core::access::MediaFiles>,
}

impl<M: TextEngine + 'static> LocalEngine<M> {
    /// Starts the app (its first frame goes to `sink` before this returns);
    /// `None` if it could not start (reported to `sink`).
    pub fn start<S: MountSink>(config: EngineConfig, text_engine: M, sink: S) -> Option<Self> {
        Self::start_with(config, text_engine, sink, |_| {})
    }

    /// [`LocalEngine::start`], with `setup` sending input before the engine
    /// starts, as [`Engine::start_with`]'s does: the link that launched the
    /// app is there before its code runs.
    pub fn start_with<S: MountSink>(
        config: EngineConfig,
        text_engine: M,
        sink: S,
        setup: impl FnOnce(&EngineControl),
    ) -> Option<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        let image_cache = config.cache.open_images(config.app.app_id());
        let media_files = Arc::new(media_files(&config, &app_access(&config.app)));
        let (tx, rx) = crossbeam_channel::unbounded();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let control = EngineControl {
            tx: tx.clone(),
            events_sent: Arc::default(),
            modality: Arc::default(),
        };
        setup(&control);
        let _clock = config.clock.enter();
        let _context = config.context.enter();
        let driver = Driver::start(config, text_engine, Rc::new(sink), tx, &rx, stop)?;
        Some(LocalEngine {
            driver: ManuallyDrop::new(driver),
            rx,
            control,
            wake: None,
            pumping: Arc::default(),
            #[cfg(not(target_arch = "wasm32"))]
            image_cache,
            media_files,
        })
    }

    /// The disk cache of the images the app downloads
    /// ([`EngineConfig::cache`]; `None`: none).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn image_cache(&self) -> Option<nsh_core::image::DiskCache> {
        self.image_cache.clone()
    }

    /// The immutable local-media roots granted by this engine configuration.
    pub fn media_files(&self) -> Arc<nsh_core::access::MediaFiles> {
        self.media_files.clone()
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

    /// Serves `ui_sets` (a superset of the config's, after a UI set or
    /// part was registered while the app runs: the web runtime's late
    /// gates) to what is mounted from now on.
    pub fn extend_ui_sets(&mut self, ui_sets: &[nsh_core::element::Registry]) {
        let sets: Vec<_> = nsh_core::runtime::registries()
            .iter()
            .chain(ui_sets)
            .cloned()
            .collect();
        self.driver
            .state
            .core
            .extend_components(nsh_core::element::Registry::merged(&sets));
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
    /// [`Bundle::trial`], told the app is healthy when the engine stops
    /// after its first frame. Only the native engine thread ([`run`]) stops
    /// that way; WebAssembly has no such stop.
    #[cfg(not(target_arch = "wasm32"))]
    trial: Option<Arc<dyn Trial>>,
    /// Tells the dropping [`Engine`] whether the app has quit listeners.
    quit_listeners: Arc<std::sync::atomic::AtomicBool>,
    /// The quit listeners run ([`Driver::quit`]): frames are not submitted
    /// any more.
    quitting: bool,
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
        drawn_shaders(&mut config.environment, false);
        let trial = match &config.app {
            App::Js(bundle) => bundle.trial.clone(),
            App::Rust(_) => None,
        };
        #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
        let system_tx = tx.clone();
        #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
        let host_bridge = config.host.bridge(tx.clone());
        let host_tx = tx.clone();
        let text_engine = Rc::new(text_engine);
        let access = Arc::new(app_access(&config.app));
        let mut core = Core::new(text_engine.clone(), config.viewport);
        core.set_content_culling(config.content_culling);
        core.set_tree_order_tracking(sink.needs_tree_order());
        core.set_projected_state_mounting(sink.needs_projected_states());
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
        if let App::Js(bundle) = &config.app {
            // What `//` media sources resolve against, as `fetch`'s URLs do.
            core.set_base_url(bundle.base_url.clone());
        }
        // The roots local media files are read under, as `fs/promises`
        // reads files (where it has a file system: the desktops).
        let media_files = Arc::new(media_files(&config, &access));
        core.set_media_files(media_files.clone());
        #[cfg(not(target_arch = "wasm32"))]
        core.set_image_context(nsh_core::image::loader::Context {
            asset_base: config.assets.as_ref().and_then(|a| a.base()),
            read_asset: config.assets.clone().map(|assets| {
                nsh_core::image::loader::ReadAsset::new(move |uri: &str| assets.read(uri))
            }),
            access: access.clone(),
            media_files,
            // The same cache as the platform's ([`Engine::image_cache`]).
            disk: config.cache.open_images(config.app.app_id()),
            // The platform's, if it set one ([`nsh_core::image::loader::set_transport`]).
            transport: None,
        });
        core.set_storage(app_storage(&config));
        core.set_data_dir(
            config
                .data_dir
                .as_ref()
                .map(|root| root.join(app_dir_name(config.app.app_id()))),
        );
        core.set_clipboard(config.clipboard.clone());
        core.set_picker(config.picker.clone());
        core.set_speech(config.speech.clone());
        core.set_url_schemes(config.app.url_schemes().iter().cloned());
        // Every VM reads the core's address where it is (`UrlScheme.url()`).
        #[cfg(any(feature = "js-core", all(feature = "browser", target_arch = "wasm32")))]
        let app_url = core.app_url_cell();
        core.set_audio(config.audio.clone());
        core.set_window_backend(config.windows.clone());
        if let Some(window) = config.app.main_window() {
            core.set_main_window(window);
        }
        core.set_font_scale(config.environment.font_scale);
        core.set_class_environment(class_environment(&config.environment));
        core.set_header_heights(config.header_heights.0, config.header_heights.1);
        core.set_safe_area(insets(&config.environment));
        core.set_environment(ui_environment(&config.environment, config.viewport));
        // WebAssembly has no threads for a runtime: tasks' timers are
        // `nsh_core::time`'s there, fired by the driver.
        #[cfg(not(target_arch = "wasm32"))]
        let runtime = config.runtime.clone().unwrap_or_else(shared_runtime);
        #[cfg(not(target_arch = "wasm32"))]
        core.set_task_runtime(runtime.clone());
        // A Rust app's theme and fonts come with its root (a JS app's from
        // its bundle).
        if let App::Rust(root) = &config.app {
            if let Some(tokens) = root.tokens_ref() {
                core.set_tokens(tokens.clone());
            }
            if let Some(appearance) = root.appearance_ref() {
                core.set_appearance(appearance);
            }
            if let Some(translations) = root.translations_ref() {
                core.set_translations(translations.clone());
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
        // So are the displays, which the app reads as it first renders,
        // and the link that launched the app, which its first `url()` reads
        // (the core keeps it for the first `open` listener too).
        let mut early = Vec::new();
        let mut displays: Arc<[nsh_core::desktop::Display]> = Arc::from(Vec::new());
        while let Ok(message) = rx.try_recv() {
            match message {
                Message::Tokens(tokens) => core.set_host_tokens(tokens.map(|t| *t)),
                Message::HostFont(data) => {
                    if let Err(err) = core.register_font(&data) {
                        log::error!("font failed: {err}");
                    }
                }
                Message::Displays(list) => {
                    core.set_displays(list.clone());
                    displays = list;
                }
                Message::Event(nsh_core::ROOT_ID, EventKind::UrlScheme, payload) => {
                    core.component_event(nsh_core::ROOT_ID, EventKind::UrlScheme, &payload);
                }
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
            resize_burst_ends: None,
            window_state: WindowStateReport {
                shown: config.environment.window_state,
                ..WindowStateReport::default()
            },
            events_handled: 0,
            events_reported: 0,
            pinned: config.pinned,
            environment: config.environment,
            shaders_unavailable: false,
            app_locale: None,
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
                assets: config.assets.clone(),
                #[cfg(not(target_arch = "wasm32"))]
                runtime,
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
            #[cfg(not(target_arch = "wasm32"))]
            trial: trial.clone(),
            quit_listeners: Arc::default(),
            quitting: false,
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
                        updater: UpdaterOverNetwork::host(
                            config.network.clone(),
                            config.assets.clone(),
                            bundle,
                        ),
                        app_url: app_url.clone(),
                        data_dir: config
                            .data_dir
                            .as_ref()
                            .map(|root| root.join(app_dir_name(config.app.app_id()))),
                        paths: bundle_system_paths(bundle),
                        wake: Arc::new(move || {
                            let _ = system_tx.send(Message::Wake);
                        }),
                        host: Rc::new(host_bridge),
                        lazy_rows: config.content_culling,
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
                    &displays,
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
            if let Message::Advance(..) | Message::Flush(..) = message {
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
        state.run_on_main_thread(&**sink);
        if let Some(trial) = trial {
            start_trial(trial);
        }
        // A resize that came while the app started is in the first frame:
        // reported as a turn reports it, or a platform waiting for the
        // layout at that size waits until something else wakes the engine.
        if let Some(size) = state.resized.take() {
            sink.resized(size);
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
            self.state.resize_burst_ends,
            self.state.window_state.settles,
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
            Message::Flush(done) => {
                let running = self.flush(rx);
                done(running && self.idle(rx));
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

    /// Runs what is queued and what is due now ([`EngineControl::flush`]),
    /// again while that queues more, [`MAX_FLUSH_ROUNDS`] times at most.
    /// False on shutdown.
    fn flush(&mut self, rx: &Receiver<Message>) -> bool {
        let frames = self.clock.moves_with_frames();
        for _ in 0..MAX_FLUSH_ROUNDS {
            while let Ok(message) = rx.try_recv() {
                if !self.handle(message, rx) {
                    return false;
                }
            }
            // A manual clock stays where it is: what is due now runs.
            if !self.advance(std::time::Duration::ZERO, rx, frames) {
                return false;
            }
            // What a turn queued (a task's wake, a response answered at
            // once) runs too, as long as it stops coming.
            if rx.is_empty() {
                break;
            }
        }
        true
    }

    /// Whether nothing is left to run: no message queued, nothing due at
    /// the clock's time (a timer that keeps scheduling another at once
    /// outlasts a flush's rounds) and no request or module load in flight.
    fn idle(&self, rx: &Receiver<Message>) -> bool {
        let now = self.clock.now();
        #[cfg(not(target_arch = "wasm32"))]
        let chunks = self.state.chunks.as_ref().is_none_or(chunks::Loads::idle);
        #[cfg(target_arch = "wasm32")]
        let chunks = true;
        rx.is_empty()
            && self.state.net.idle()
            && chunks
            && [self.due(), self.clock.next_alarm()]
                .into_iter()
                .flatten()
                .all(|at| at > now)
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
        if state
            .resize_burst_ends
            .is_some_and(|ends| ends <= nsh_core::time::now())
        {
            state.resize_burst_ends = None;
            state.core.set_resizing(false);
        }
        if state
            .window_state
            .settles
            .is_some_and(|due| due <= nsh_core::time::now())
            && let Some(env) = state.window_state.reported
        {
            state.window_state.settles = None;
            state.window_state.shown = env.window_state;
            apply_environment(script, state, env);
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
        let batch = state.commit(script);
        if let Some(batch) = batch.filter(|_| !self.quitting) {
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
        state.run_on_main_thread(&**sink);
        if let Some(size) = state.resized.take() {
            sink.resized(size);
        }
        state.report_handled(&**sink);
        state.net.pump(script, &mut state.core);
        state.load_chunks(script, &**sink);
        state.request_frame(script, &**sink);
        self.check_stopped();
        self.sync_quit_listeners();
    }

    /// Tells the [`Engine`] whether the app has quit listeners now.
    fn sync_quit_listeners(&self) {
        self.quit_listeners.store(
            self.state.core.has_quit_listeners(),
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// The engine stops: runs the app's quit listeners and what they wait
    /// for, [`QUIT_TIMEOUT`] at most (the dropping [`Engine`] interrupts JS
    /// then). Their frames are not submitted; the embedding app's events
    /// stay queued behind the shutdown, for the next app.
    #[cfg(not(target_arch = "wasm32"))]
    fn quit(&mut self, rx: &Receiver<Message>) {
        if !self.state.core.has_quit_listeners() {
            return;
        }
        let deadline = Instant::now() + QUIT_TIMEOUT;
        self.quitting = true;
        self.state.core.start_quit();
        let mut kept = Vec::new();
        loop {
            self.turn();
            if !self.state.core.quit_pending() || self.stopped {
                break;
            }
            let wake = self.deadline().map_or(deadline, |at| at.min(deadline));
            match rx.recv_deadline(wake) {
                Ok(Message::Shutdown) => {}
                Ok(message @ Message::HostEvent(..)) => kept.push(message),
                Ok(message) => {
                    self.handle(message, rx);
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
            if Instant::now() >= deadline {
                log::warn!(
                    "the app's quit listeners did not finish in {} ms",
                    QUIT_TIMEOUT.as_millis()
                );
                break;
            }
        }
        for message in kept {
            let _ = self.state.net.tx.send(message);
        }
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
            // What the app holds, for the performance monitor: read here,
            // when the heap was just walked and nothing waits.
            if let Some(monitor) = &self.state.perf {
                let (js_heap, js_objects) = script.heap_usage();
                monitor.set_memory(perf::MemorySample {
                    js_heap,
                    js_objects,
                    nodes: self.state.core.node_count() as u64,
                    node_ids: self.state.core.node_id_room() as u64,
                });
            }
            self.last_gc = Instant::now();
            self.state.committed_since_gc = false;
            if let Some(batch) = self.state.commit(Some(script)) {
                self.sink.submit(batch);
            }
            self.state.run_on_main_thread(&*self.sink);
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
    /// The environment given last, before the app's language is applied.
    environment: Environment,
    /// The platform found no GPU for shader views
    /// ([`EngineControl::shaders_unavailable`]).
    shaders_unavailable: bool,
    /// The language the app shows in whatever the user's (`setLocale`).
    app_locale: Option<nsh_core::platform::Locale>,
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
    /// A resize before this time continues a burst of them
    /// ([`RESIZE_BURST_GAP`]).
    resize_burst_ends: Option<Instant>,
    /// The window's bounds as the app reads them, held back while the
    /// window moves.
    window_state: WindowStateReport,
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
    /// Where requests of `asset:/` URLs are answered from
    /// ([`EngineConfig::assets`]).
    assets: Option<Arc<dyn Assets>>,
    /// The runtime whose blocking pool reads them (the components'
    /// tasks').
    #[cfg(not(target_arch = "wasm32"))]
    runtime: tokio::runtime::Handle,
}

/// The task of a request for a bundled file while it is read: the read
/// finishes on its own, and a cancelled request drops what it gives.
struct AssetTask;

impl FetchTask for AssetTask {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}

/// Whether `url` names a bundled file (`asset:/…`, the scheme in any case,
/// as URL schemes are).
fn is_asset(url: &str) -> bool {
    url.get(..6)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("asset:"))
}

/// `url` (an `asset:/` URL) as its response answers at it, and as the
/// rest of the engine reads it: the scheme in lower case, as URL parsers
/// write it (schemes are case-insensitive, and JS's `fetch` parses the URL
/// before the engine sees it), without the fragment, which no request
/// sends and no response carries.
fn asset_response_url(url: &str) -> String {
    let rest = url.get(6..).unwrap_or_default();
    format!("asset:{}", rest.split('#').next().unwrap_or_default())
}

/// The bundled file a request reads, by the URL [`asset_response_url`]
/// wrote: its path alone, as hosts read it. A query is no part of a file's
/// name, so `asset:/a.json?v=2` reads `asset:/a.json` on every host, as a
/// web server serves it.
fn asset_file(url: &str) -> &str {
    url.split('?').next().unwrap_or_default()
}

/// A request in flight.
struct Inflight {
    task: Box<dyn FetchTask>,
    /// The hop the task is.
    hop: u64,
    /// Requests whose redirects the engine follows (to check each hop).
    followed: Option<access::Followed>,
    /// The `asset:/` URL a download of a bundled file answers at
    /// ([`asset_response_url`]): a status other than a success fails it, as
    /// a file the host does not have does.
    asset: Option<String>,
}

impl Net {
    /// Whether no request waits for the network.
    fn idle(&self) -> bool {
        self.inflight.is_empty()
    }

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
                core.fetch_refused(id, refused.message, refused.url);
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

    /// Makes `who`'s request, if the app may (else why not). Bundled files
    /// are the app's own: their requests need no capability.
    fn request(&mut self, who: Requester, mut request: HttpRequest) -> Result<(), access::Refused> {
        if is_asset(&request.url) {
            self.asset(who, request);
            return Ok(());
        }
        if self.access.is_unrestricted() {
            self.start(who, request, None);
            return Ok(());
        }
        // The request goes out with the URL the check granted: Rust's and
        // `registerFont`'s URLs come as written, `fetch`'s already parsed.
        match self.access.http_url(&request.method, &request.url) {
            Some(url) => request.url = url.into_owned(),
            None => return Err(access::refused(&request.method, &request.url)),
        }
        if request.follow_redirects {
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
                asset: None,
            },
        );
    }

    /// Answers `who`'s request of a bundled file (an `asset:/` URL) from
    /// the host's assets: read on the runtime's blocking pool, which reports
    /// with [`Message::AssetRead`] (in WebAssembly, which has no threads,
    /// here).
    fn asset(&mut self, who: Requester, mut request: HttpRequest) {
        request.url = asset_response_url(&request.url);
        let file = asset_file(&request.url).to_owned();
        self.hops += 1;
        let hop = self.hops;
        self.inflight.insert(
            who,
            Inflight {
                task: Box::new(AssetTask),
                hop,
                followed: None,
                asset: None,
            },
        );
        // Failed here, before any host reads the file or serves it
        // ([`Assets::url`]): a request no host may answer reaches none.
        let refused = if !nsh_core::access::is_inside_assets(&file) {
            Some(format!(
                "{}: bundled files are named by a path inside the app's files",
                request.url
            ))
        } else if !matches!(request.method.as_str(), "GET" | "HEAD") {
            Some(format!(
                "{} {}: bundled files are read with GET",
                request.method, request.url
            ))
        } else {
            None
        };
        if let Some(refused) = refused {
            let _ = self
                .tx
                .send(Message::Fetch(who, hop, FetchEvent::Failed(refused)));
            return;
        }
        let Some(assets) = &self.assets else {
            let failed = Err("this host cannot load assets".to_owned());
            self.asset_read(who, hop, request, failed);
            return;
        };
        #[cfg(not(target_arch = "wasm32"))]
        {
            let assets = assets.clone();
            let tx = self.tx.clone();
            // The read reports itself; nothing awaits its handle.
            drop(self.runtime.spawn_blocking(move || {
                let bytes = assets.read(&file);
                let _ = tx.send(Message::AssetRead(who, hop, request, bytes));
            }));
        }
        #[cfg(target_arch = "wasm32")]
        {
            let bytes = assets.read(&file);
            self.asset_read(who, hop, request, bytes);
        }
    }

    /// Hop `hop` of `who`'s request of a bundled file read it: its response,
    /// or, when the host has no copy but serves the file at a URL
    /// ([`Assets::url`]), the download of it. Only requests [`Net::asset`]
    /// let through come here. Dropped when the request was cancelled
    /// meanwhile.
    fn asset_read(
        &mut self,
        who: Requester,
        hop: u64,
        request: HttpRequest,
        read: Result<Vec<u8>, String>,
    ) {
        if self.inflight.get(&who).is_none_or(|i| i.hop != hop) {
            return;
        }
        let events = match read {
            Ok(bytes) => {
                let head = HttpHead {
                    status: 200,
                    status_text: "OK".to_owned(),
                    headers: vec![
                        ("content-length".to_owned(), bytes.len().to_string()),
                        (
                            "content-type".to_owned(),
                            content_type(asset_file(&request.url)).to_owned(),
                        ),
                    ],
                    url: request.url.clone(),
                    ..HttpHead::default()
                };
                let mut events = vec![FetchEvent::Head(head)];
                if request.method == "GET" && !bytes.is_empty() {
                    events.push(FetchEvent::Data(bytes));
                }
                events.push(FetchEvent::End);
                events
            }
            Err(error) => {
                match (self.assets.as_ref()).and_then(|a| a.url(asset_file(&request.url))) {
                    Some(url) => {
                        self.inflight.remove(&who);
                        let uri = request.url.clone();
                        self.start(who, HttpRequest { url, ..request }, None);
                        if let Some(download) = self.inflight.get_mut(&who) {
                            download.asset = Some(uri);
                        }
                        return;
                    }
                    None => vec![FetchEvent::Failed(error)],
                }
            }
        };
        for event in events {
            let _ = self.tx.send(Message::Fetch(who, hop, event));
        }
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
            FetchEvent::Head(mut head) => {
                let missing = (inflight.asset.as_ref())
                    .filter(|_| !(200..300).contains(&head.status))
                    .map(|uri| format!("{uri}: HTTP {}", head.status));
                if let Some(missing) = missing {
                    if let Some(i) = self.inflight.remove(&id) {
                        i.task.cancel();
                    }
                    return Some(Ok(FetchEvent::Failed(missing)));
                }
                // A downloaded bundled file answers as one read from the
                // app's files: its `asset:/` URL, and a type even where the
                // server gave none.
                if let Some(uri) = &inflight.asset {
                    head.url = uri.clone();
                    head.redirected = false;
                    if !head
                        .headers
                        .iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                    {
                        let file_type = content_type(asset_file(uri)).to_owned();
                        head.headers.push(("content-type".to_owned(), file_type));
                    }
                }
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

    /// Sends the pending touch move.
    fn dispatch_touch_move(&mut self, script: Option<&Script>) {
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
            .retain(|&id, _| core.scroll_listener(id).is_some());
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
                || self.core.has_paced_mounts()
                || (script.is_some() && self.core.has_paced_list_binds()))
        {
            self.frame_requested = true;
            sink.request_frame();
        }
    }

    /// Hands the sink the functions the app asked to run on the main thread
    /// this turn, after the turn's batch.
    fn run_on_main_thread(&mut self, sink: &dyn MountSink) {
        for task in self.core.take_main_thread_tasks() {
            sink.run_on_main_thread(task);
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
        // The views made this turn share one budget (`nsh_core`'s `pace.rs`).
        self.core.begin_mount_turn();
        for _ in 0..MAX_LIST_ROUNDS {
            // Requests from the previous round (or frame) first.
            let js_start = Instant::now();
            // Without JS, lists bind nowhere (Rust components' lists bind in
            // the core).
            let binds = self.binds.drain(..);
            if let Some(script) = script {
                for bind in binds {
                    script.bind_list(bind.list, &bind.binds);
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
                    for bind in binds.drain(..) {
                        paced.cells += bind.binds.len();
                        script.bind_list(bind.list, &bind.binds);
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
            release_spare_ops(&mut self.ops);
            if let Some(batch) = self.core.commit() {
                commits += 1;
                match &mut merged {
                    Some(m) => extend_frame(&mut m.items, batch.items),
                    None => merged = Some(batch),
                }
            }
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
            // A language the app asked for reaches the core and JS, whose
            // views follow it in another round.
            let relocale = match self.core.take_locale_request() {
                Some(locale) => {
                    self.app_locale = locale;
                    apply_environment(script, self, self.environment);
                    true
                }
                None => false,
            };
            let more_paced = script.is_some() && paced.left() && self.core.has_paced_list_binds();
            // What waited for the app's answer to the events just taken runs
            // in the next round, once JS has handled them, and shows in this
            // batch.
            let answers = self.core.has_due_answers();
            if self.binds.is_empty()
                && self.events.is_empty()
                && !posted
                && !retheme
                && !relocale
                && !more_paced
                && !urls
                && !answers
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
        window_state: env.window_state,
        keyboard_height: env.keyboard_height,
        keyboard_duration: env.keyboard_duration,
        dark: env.color_scheme == ColorScheme::Dark,
        font_scale: env.font_scale,
        reduce_motion: env.reduce_motion,
        screen_reader: env.screen_reader,
        rtl: env.rtl,
        pixel_ratio: env.pixel_ratio,
        os: env.os,
        platform: env.platform,
        os_version: env.os_version,
        idiom: env.idiom,
        locale: env.locale,
        locale_settings: env.locale_settings,
        apple_keyboard: env.apple_keyboard,
        ctrl_for_command: env.ctrl_for_command,
        native_focus_scopes: env.native_focus_scopes,
        host: env.host,
        lifecycle: env.lifecycle,
        screen_color: env.screen_color,
        file_requests: env.file_requests,
        speech: env.speech,
        notifications: env.notifications,
        audio: env.audio,
        cell: env.cell,
        web_input: env.web_input,
        web_evaluate: env.web_evaluate,
        web_views: env.web_views,
        shaders: env.shaders,
    }
}

/// `Environment::shaders` as the app sees it: the platform's, `false` on a
/// grid surface (a terminal's Cells) and once the platform or this process
/// found no GPU (`unavailable`: [`EngineControl::shaders_unavailable`]).
fn drawn_shaders(env: &mut Environment, unavailable: bool) {
    env.shaders &= env.cell.is_none() && !unavailable && !shader::no_gpu();
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
        pointer: if env.desktop() {
            nsh_core::tailwind::Pointer::Fine
        } else {
            nsh_core::tailwind::Pointer::Coarse
        },
        terminal: env.idiom == Idiom::Terminal,
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
    core.take_emitted_events(pending);
    let handled = core.component_event(id, kind, payload);
    let mut events = Vec::new();
    core.take_emitted_events(&mut events);
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

/// How long the window stays where it is before a move or a resize
/// reaches the app ([`WindowStateReport`]).
const WINDOW_SETTLE: Duration = Duration::from_millis(150);

/// The window's bounds the app reads: a move or a resize reaches it once
/// the window has stayed for [`WINDOW_SETTLE`] (one report at the end of a
/// drag, not one per point), a change of mode, display or being minimized
/// or hidden at once (with the bounds of then).
#[derive(Default)]
struct WindowStateReport {
    /// What the app reads.
    shown: Option<nsh_core::desktop::WindowState>,
    /// The platform's latest environment while a move settles.
    reported: Option<Environment>,
    /// When it has settled.
    settles: Option<Instant>,
}

impl WindowStateReport {
    /// The environment the app gets of `env`, the platform's at `now`: its
    /// window state held back while it moves.
    fn report(&mut self, mut env: Environment, now: Instant) -> Environment {
        let next = env.window_state;
        let moving = match (&self.shown, &next) {
            (Some(shown), Some(next)) => shown != next && moved_only(shown, next),
            _ => false,
        };
        if moving {
            // The window moved again (not some other part of the
            // environment): it settles from now.
            let moved = self.reported.map(|r| r.window_state) != Some(next);
            if moved || self.settles.is_none() {
                self.settles = Some(now + WINDOW_SETTLE);
            }
            self.reported = Some(env);
            env.window_state = self.shown;
        } else {
            self.reported = None;
            self.settles = None;
            self.shown = next;
        }
        env
    }
}

/// Whether `next` differs from `shown` by where the window is or its size
/// alone (a move or a resize, which settles before it is reported), not by
/// its mode, display, focus, scale or being minimized or visible.
fn moved_only(
    shown: &nsh_core::desktop::WindowState,
    next: &nsh_core::desktop::WindowState,
) -> bool {
    shown.mode == next.mode
        && shown.placement.mode == next.placement.mode
        && shown.minimized == next.minimized
        && shown.visible == next.visible
        && shown.focused == next.focused
        && shown.display == next.display
        && shown.scale_factor == next.scale_factor
}

/// Gives the core and JS the environment `env`.
fn apply_environment<M: TextEngine>(
    script: Option<&Script>,
    state: &mut State<M>,
    env: Environment,
) {
    state.environment = env;
    let mut env = env;
    // The app's language (`set_locale`) over the platform's, as an
    // embedding app's own is.
    if let Some(locale) = state.app_locale {
        env.locale = locale;
        env.locale_settings.languages = env.locale_settings.languages.preferring(locale);
    }
    state.core.set_font_scale(env.font_scale);
    state.core.set_class_environment(class_environment(&env));
    state.core.set_safe_area(insets(&env));
    let window = env.window;
    state.core.set_environment(ui_environment(&env, window));
    if let Some(script) = script {
        script.set_environment(&env);
    }
}

/// Returns false on shutdown.
fn handle<M: TextEngine>(script: Option<&Script>, state: &mut State<M>, message: Message) -> bool {
    match message {
        Message::Event(id, event, mut payload) => {
            state.events_handled += 1;
            if state.trace {
                log::info!(target: "nsh::perf", "event {event:?} on view {id}");
            }
            // Mouse moves wait for the frame, the latest per view; any other
            // event comes after the moves before it (a view hears where the
            // mouse went before it hears it leave). A drag on the desktops
            // also sends a touch move with each mouse move: that is the same
            // motion, not an event after it.
            if event == EventKind::MouseMove {
                match state.mouse_moves.iter_mut().find(|(v, _)| *v == id) {
                    Some((_, pending)) => *pending = payload,
                    None => state.mouse_moves.push((id, payload)),
                }
                return true;
            }
            if !matches!(&payload, EventPayload::Touch(t) if t.phase == nsh_core::TouchPhase::Move)
            {
                state.dispatch_mouse_moves(script);
            }
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
            if event == EventKind::SelectionChange {
                state.core.locate_selection(id, &mut payload);
            }
            if event == EventKind::Paste {
                payload = payload.into_paste();
            }
            // A secondary click goes down as a press does: the overlays it
            // is outside of hear `onPressOutside` first, then the view its
            // `onContextMenu`, so a context menu open on the view closes
            // before the view asks for one again where the pointer is.
            if let EventPayload::ContextMenu(menu) = &payload {
                for (overlay, pressed) in state.core.context_menu_presses_outside(id, menu) {
                    if !state
                        .core
                        .component_event(overlay, EventKind::PressOutside, &pressed)
                        && let Some(script) = script
                    {
                        script.dispatch_event(overlay, EventKind::PressOutside, &pressed);
                    }
                }
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
        Message::ContentCulling(enabled) => {
            state.core.set_content_culling(enabled);
            if let Some(script) = script {
                script.set_lazy_rows(enabled);
            }
        }
        Message::InputScroll(id, offset, content, viewport) => {
            state.core.set_input_scroll(id, offset, content, viewport);
        }
        Message::Zoom(id, scale) => state.core.set_zoom(id, scale),
        Message::ComponentSize(id, size) => state.core.set_component_size(id, size),
        Message::AnimationsFinished(mut finished) => {
            // The components' animations end in the core, JS's in JS.
            state.core.animations_finished(&mut finished);
            if let Some(script) = script {
                script.animations_finished(&finished);
            }
        }
        Message::Resize(size) => {
            // The next within a burst's gap: a window being dragged. A manual
            // clock wakes nothing to end one, and a test wants its layout whole.
            if !nsh_core::time::manual() {
                let now = nsh_core::time::now();
                if state.resize_burst_ends.is_some_and(|ends| now < ends) {
                    state.core.set_resizing(true);
                }
                state.resize_burst_ends = Some(now + RESIZE_BURST_GAP);
            }
            state.core.set_viewport(size);
            state.resized = Some(size);
        }
        Message::Wake => {}
        Message::Environment(mut env) => {
            state.pinned.apply(&mut env);
            drawn_shaders(&mut env, state.shaders_unavailable);
            let env = state.window_state.report(*env, nsh_core::time::now());
            apply_environment(script, state, env);
        }
        Message::ShadersUnavailable => {
            state.shaders_unavailable = true;
            if state.environment.shaders {
                let env = Environment {
                    shaders: false,
                    ..state.environment
                };
                apply_environment(script, state, env);
            }
        }
        Message::Displays(displays) => {
            state.core.set_displays(displays.clone());
            if let Some(script) = script {
                script.set_displays(&displays);
            }
        }
        Message::FocusPath(path) => {
            state.core.set_focus_path(&path);
            if let Some(script) = script {
                script.set_focus_path(&path);
            }
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
        Message::States(id, states) => state.core.set_states(id, states),
        Message::Modality(modality) => state.core.set_input_modality(modality),
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
            (Requester::Task(id), Some(Ok(event))) => {
                if !state.core.fetch_event(id, event) {
                    state.net.cancel(who);
                }
            }
            // A redirect the app may not follow: its hop is cancelled
            // already (`Net::event`).
            (Requester::Task(id), Some(Err(refused))) => {
                state.core.fetch_refused(id, refused.message, refused.url)
            }
        },
        Message::AssetRead(who, hop, request, read) => {
            state.net.asset_read(who, hop, request, read)
        }
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
            state.core.set_perf_monitor(monitor.is_some());
            if let Some(script) = script {
                script.set_fps_enabled(monitor.is_some());
            }
            state.perf = monitor;
            state.perf_commit = perf::CommitTiming::default();
        }
        Message::Tokens(tokens) => {
            state.core.set_host_tokens(tokens.map(|t| *t));
            if let Some(script) = script {
                script.set_theme_tokens(state.core.theme_tokens());
            }
        }
        Message::HostFont(data) => {
            if let Err(err) = state.core.register_font(&data) {
                log::error!("font failed: {err}");
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
        Message::Advance(..) | Message::Flush(..) => unreachable!("the driver moves the clock"),
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

/// The most ops an emptied op buffer keeps room for.
const RETAINED_OPS: usize = 16 * 1024;

/// Gives back what a large commit (a screen made at once, a long list
/// bound) grew the emptied op buffer to: it and the runtime's take turns
/// ([`Script::take_ops`] swaps them), and each would otherwise hold the
/// largest commit's capacity for the life of the app.
fn release_spare_ops(ops: &mut Vec<Op>) {
    debug_assert!(ops.is_empty());
    if ops.capacity() > RETAINED_OPS {
        ops.shrink_to(RETAINED_OPS);
    }
}

/// What `app` may reach: a JS app its policy's grant; native code is
/// trusted, it reaches what the platform allows.
fn app_access(app: &App) -> Access {
    match app {
        App::Js(bundle) => bundle.policy.access(),
        App::Rust(_) => Policy::default().access(),
    }
}

/// The roots local media files are read under, as `fs/promises` reads
/// files (where it has a file system: the desktops).
fn media_files(config: &EngineConfig, access: &Access) -> nsh_core::access::MediaFiles {
    match &config.app {
        App::Js(bundle) => nsh_core::access::MediaFiles::new(
            access,
            config
                .data_dir
                .as_ref()
                .map(|root| root.join(app_dir_name(config.app.app_id())))
                .as_deref(),
            &bundle_system_paths(bundle),
            nsh_core::access::native_files(config.environment.os),
        ),
        _ => nsh_core::access::MediaFiles::default(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_emptied_op_buffer_gives_back_what_a_large_commit_grew() {
        let mut ops: Vec<super::Op> = Vec::with_capacity(super::RETAINED_OPS * 8);
        super::release_spare_ops(&mut ops);
        assert!(ops.capacity() <= super::RETAINED_OPS);
        // A buffer of ordinary commits keeps its room.
        let mut ops: Vec<super::Op> = Vec::with_capacity(1024);
        super::release_spare_ops(&mut ops);
        assert_eq!(ops.capacity(), 1024);
    }

    #[test]
    fn moves_settle_and_changes_of_mode_do_not() {
        use nsh_core::{
            desktop::{DisplayId, WindowMode, WindowPlacement, WindowState},
            geometry::{Bounds, point, px, size},
        };
        let rect = |x: f32| Bounds::new(point(px(x), px(0.0)), size(px(800.0), px(600.0)));
        let a = WindowState::new(
            rect(0.0),
            WindowPlacement::new(WindowMode::Normal, rect(0.0)),
        );
        let mut moved = a;
        moved.bounds = rect(10.0);
        moved.placement = WindowPlacement::new(WindowMode::Normal, rect(10.0));
        assert!(super::moved_only(&a, &moved));
        let mut maximized = a;
        maximized.mode = WindowMode::Maximized;
        maximized.placement = WindowPlacement::new(WindowMode::Maximized, rect(0.0));
        assert!(!super::moved_only(&a, &maximized));
        let mut minimized = a;
        minimized.minimized = true;
        assert!(!super::moved_only(&a, &minimized));
        let mut hidden = a;
        hidden.visible = false;
        assert!(!super::moved_only(&a, &hidden));
        let mut elsewhere = a;
        elsewhere.display = Some(DisplayId(2));
        assert!(!super::moved_only(&a, &elsewhere));
    }

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
                .on_press(move |_: &()| cx.emit(Pressed::Press))
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
