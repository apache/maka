//! WebAssembly backend for nsh: runs an app in a browser page and renders
//! it to the DOM: apps published with `nsh package --target web`, the web
//! development host and the website's live demos. `platform.os` is `"web"`;
//! the page reports the idiom (phone, tablet or desktop browser), locale
//! and the user's settings ([`nsh_environment`]).
//!
//! - The engine runs on the page's main thread ([`nsh_engine::LocalEngine`]):
//!   the JS runtime (`web/nsh.js`) calls [`nsh_pump`] after input and when
//!   the deadline it returned is reached.
//! - Each commit becomes one JSON batch ([`encode`]) applied by the DOM
//!   mounter: absolutely positioned elements at the frames the core laid
//!   out, CSS made here from the view styles.
//! - Text is laid out here with the browser's font measurements and drawn
//!   run by run ([`text`]); native animations run here on
//!   `requestAnimationFrame` ([`animation`]).
//!
//! - `fetch` runs on the browser's `fetch` ([`net`]).
//!
//! There are no native components; web views are `<iframe>`s and scroll
//! views use the browser's scrolling. Off WebAssembly this crate is empty.

#![cfg(target_arch = "wasm32")]

mod animation;
mod canvas;
mod encode;
mod ffi;
mod filesystem;
#[cfg(feature = "js")]
mod local_time;
mod net;
mod storage;
mod text;
mod websocket;

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    EventKind, EventPayload, MountBatch, MountItem, PayloadValue, Points, ROOT_ID, Size,
    geometry::{DevicePixels, point, px, size},
    keymap::{Key, KeyMatch, Keymap, Keystroke, Modifiers},
};
use nsh_engine::{
    App, Assets, ColorScheme, EngineConfig, EngineControl, Environment, Idiom, Limits, LocalEngine,
    MountSink, Os,
};
#[cfg(feature = "js")]
use nsh_engine::{Bundle, BundleCode, Chunk, HotUpdate, Policy};

use crate::{animation::UiAnimation, encode::Out, text::WebTextEngine};
pub use crate::{
    filesystem::nsh_filesystem_reply,
    net::{nsh_fetch_body_wanted, nsh_fetch_data, nsh_fetch_end, nsh_fetch_failed, nsh_fetch_head},
    storage::nsh_storage_reply,
    websocket::{nsh_websocket_event, nsh_websocket_reply},
};

thread_local! {
    static APP: RefCell<Option<Running>> = const { RefCell::new(None) };
    /// Batches submitted during a pump, applied after it (the sink cannot
    /// reach the running app while it pumps).
    static BATCHES: RefCell<Vec<MountBatch>> = const { RefCell::new(Vec::new()) };
    /// The bytes of the asset JS hands over in `read_asset`.
    pub(crate) static ASSET: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static FRAME_REQUESTED: Cell<bool> = const { Cell::new(false) };
    /// A test session's model of the app (`nsh test --target web`,
    /// [`nsh_test_start`]): every batch and error goes to it.
    #[cfg(feature = "dev")]
    static TEST_MODEL: RefCell<Option<std::sync::Arc<nsh_testing::agent::Model>>> =
        const { RefCell::new(None) };
    /// The last answer of [`nsh_test_answer`] (JSON).
    #[cfg(feature = "dev")]
    static TEST_ANSWER: RefCell<String> = const { RefCell::new(String::new()) };
    /// The page's URL, which relative request URLs resolve against.
    static BASE_URL: RefCell<Option<String>> = const { RefCell::new(None) };
    /// How the next [`nsh_start`] runs its bundle ([`nsh_bundle_options`]).
    #[cfg(feature = "js")]
    static OPTIONS: RefCell<BundleOptions> = RefCell::new(BundleOptions::default());
    /// A hot update could not be applied in place ([`nsh_hot_failed`]).
    #[cfg(feature = "js")]
    static HOT_FAILED: Cell<bool> = const { Cell::new(false) };
    /// What the page reported last ([`nsh_environment`]), kept for the
    /// next [`nsh_start`].
    static PAGE: Cell<Option<Environment>> = const { Cell::new(None) };
    /// The app's keyboard shortcuts (`MountItem::Keymap`), matched in
    /// [`nsh_key`] while a key event is being handled. Apart from [`APP`]
    /// so that matching never needs the engine.
    static KEYMAP: RefCell<Option<std::sync::Arc<Keymap>>> = const { RefCell::new(None) };
    /// The UI sets apps import ([`set_ui_sets`]; by default `nsh/base`).
    static UI_SETS: RefCell<Option<Vec<nsh_core::ui::Registry>>> = const { RefCell::new(None) };
    /// What makes the Rust app's root ([`set_root`]), for [`nsh_start_rust`].
    static ROOT: RefCell<Option<Box<dyn Fn() -> nsh_core::ui::Root>>> = const { RefCell::new(None) };
    /// What the last [`nsh_compile`] made: the module or the error.
    #[cfg(feature = "compiler")]
    static COMPILED: RefCell<String> = const { RefCell::new(String::new()) };
}

/// What [`ui_sets!`] gives.
pub use nsh_core::ui::Registry;

/// Sets the UI sets the apps started from now on serve: `nsh/base` and
/// an app's own Rust components (`nsh.json` `"rust"`). A runtime built for
/// the app ([`ui_sets!`]) passes them before the page starts anything.
pub fn set_ui_sets(sets: Vec<Registry>) {
    UI_SETS.with(|s| *s.borrow_mut() = Some(sets));
}

/// The UI sets engines serve: [`set_ui_sets`]'s, else nsh's own.
fn ui_sets() -> Vec<Registry> {
    UI_SETS
        .with(|s| s.borrow().clone())
        .unwrap_or_else(|| vec![nsh_base::registry()])
}

/// Makes this module an app's web runtime that serves `$sets` (an
/// expression giving the `Vec<Registry>` of `nsh/base` and the app's own
/// Rust components): `nsh` builds one for apps with `"rust"` in `nsh.json`.
/// It exports `nsh_app_init`, which `nsh.js` calls once the module is
/// instantiated.
#[macro_export]
macro_rules! ui_sets {
    ($sets:expr) => {
        /// Registers the app's UI sets (`nsh.js` calls it first).
        #[unsafe(no_mangle)]
        pub extern "C" fn nsh_app_init() {
            $crate::set_ui_sets($sets);
        }
    };
}

/// Sets the Rust app [`nsh_start_rust`] runs: `root` makes its root
/// component (with its theme), each time the page starts it.
pub fn set_root(root: impl Fn() -> nsh_core::ui::Root + 'static) {
    ROOT.with(|r| *r.borrow_mut() = Some(Box::new(root)));
}

/// Makes this module the web runtime of a Rust app (`nsh.json` `"root"`):
/// it serves `$sets` (`nsh/base` and the app's own set) and runs the
/// root component `$root` makes (an expression giving a
/// [`nsh_core::ui::Root`]) when the page calls [`nsh_start_rust`]. Built
/// without the feature `js`, the module has no QuickJS: the app is Rust
/// and the browser's own JS from start to end. Exports `nsh_app_init`, as
/// [`ui_sets!`].
#[macro_export]
macro_rules! rust_app {
    ($sets:expr, $root:expr) => {
        /// Registers the app's UI sets and root (`nsh.js` calls it first).
        #[unsafe(no_mangle)]
        pub extern "C" fn nsh_app_init() {
            $crate::set_ui_sets($sets);
            $crate::set_root(|| $root);
        }
    };
}

/// What [`nsh_bundle_options`] set for the next [`nsh_start`].
#[cfg(feature = "js")]
#[derive(Default)]
struct BundleOptions {
    /// Run as a release: hardened, as packaged apps run (default:
    /// development settings, for the player and the dev server).
    release: bool,
    /// What the app declares (`capabilities.json`).
    capabilities: Option<String>,
    /// The bundle's source map (JSON).
    source_map: Option<String>,
    /// The hardening as bytecode ([`nsh_bundle_harden`]).
    harden: Option<Vec<u8>>,
    /// The app's id (`nsh.json` `"id"`): it names where the app keeps its
    /// data ([`storage::LocalStorage`]).
    app_id: Option<String>,
    /// The VM limits the page runs the app with ([`nsh_bundle_limits`]);
    /// `None`: none, as an app on its own.
    limits: Option<String>,
}

struct Running {
    engine: LocalEngine<Rc<WebTextEngine>>,
    /// The core's text engine, whose measurements go stale when a font
    /// finishes loading.
    text: Rc<WebTextEngine>,
    control: EngineControl,
    animation: UiAnimation,
    /// JS asked for a display frame (`requestAnimationFrame`).
    js_frame: bool,
    /// The surface's environment (window, appearance).
    environment: Environment,
    /// The in-memory images (`data:` URIs, blobs) the page has blob URLs
    /// of, by URI, while a view's source holds their bytes.
    inline_images: nsh_core::image::InlineImages,
}

struct Sink;

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        #[cfg(feature = "dev")]
        TEST_MODEL.with(|m| {
            if let Some(model) = &*m.borrow() {
                model.apply(&batch);
            }
        });
        BATCHES.with(|b| b.borrow_mut().push(batch));
    }

    fn report_error(&self, message: &str) {
        #[cfg(feature = "dev")]
        TEST_MODEL.with(|m| {
            if let Some(model) = &*m.borrow() {
                model.error(message);
            }
        });
        ffi::report_error(message);
    }

    fn request_frame(&self) {
        FRAME_REQUESTED.with(|f| f.set(true));
    }

    #[cfg(feature = "js")]
    fn hot_update_failed(&self) {
        HOT_FAILED.with(|f| f.set(true));
    }

    fn load_chunk(&self, id: &str) -> bool {
        ffi::load_chunk(id);
        true
    }
}

/// Bundled files the page preloaded (fonts, images drawn on a canvas).
struct PageAssets;

impl Assets for PageAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        ffi::read_asset(uri).ok_or_else(|| format!("{uri} is not available on the web"))
    }
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            ffi::log(record.level(), &record.args().to_string());
        }
    }

    fn flush(&self) {}
}

static LOGGER: Logger = Logger;

/// Memory for JS to write strings and bytes into.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees what [`nsh_alloc`] returned.
///
/// # Safety
///
/// `ptr` and `len` come from one [`nsh_alloc`] call, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_dealloc(ptr: *mut u8, len: usize) {
    // SAFETY: the caller passes what `nsh_alloc` returned for `len`.
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`] holding `len` bytes.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    // SAFETY: guaranteed by the caller.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

/// # Safety
///
/// As [`bytes`].
unsafe fn string(ptr: *const u8, len: usize) -> String {
    // SAFETY: guaranteed by the caller.
    String::from_utf8_lossy(unsafe { bytes(ptr, len) }).into_owned()
}

/// Hands the asset JS was asked for (`read_asset`) back.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_asset_bytes(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let data = unsafe { bytes(ptr, len) }.to_vec();
    ASSET.with(|a| *a.borrow_mut() = Some(data));
}

fn environment(width: f32, height: f32, dark: bool, pixel_ratio: f32) -> Environment {
    Environment {
        window: nsh_core::Size::new(nsh_core::Points(width), nsh_core::Points(height)),
        color_scheme: if dark {
            ColorScheme::Dark
        } else {
            ColorScheme::Light
        },
        pixel_ratio,
        ..page()
    }
}

/// The page's environment as last reported (`os` is the web's).
fn page() -> Environment {
    PAGE.with(Cell::get).unwrap_or(Environment {
        os: Os::Web,
        renderer: nsh_engine::Renderer::Web,
        ..Environment::default()
    })
}

/// What the page knows about the user and the device, as JSON: `idiom`
/// (`"phone"`, `"pad"`, `"desktop"`), `locale` (a BCP 47 tag), `rtl`,
/// `reduceMotion`, `fontScale`, `pixelRatio`, `safeArea` (`[top, right,
/// bottom, left]`), `keyboard` (the height the on-screen keyboard
/// covers), `appleKeyboard` (the browser runs on an Apple platform: its
/// shortcuts are Apple's) and `host` (the page answers `nsh/host` calls:
/// `createPlayer`'s `host`); missing keys keep their value. Called before [`nsh_start`]
/// and on every change; the idiom and `host` are the ones at start, as on every
/// platform. Returns the pump delay.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_environment(ptr: *const u8, len: usize) -> f64 {
    // SAFETY: guaranteed by the caller.
    let json = unsafe { string(ptr, len) };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return pump();
    };
    let mut env = page();
    let num = |k: &str| value.get(k).and_then(|v| v.as_f64()).map(|v| v as f32);
    let flag = |k: &str| value.get(k).and_then(|v| v.as_bool());
    if let Some(idiom) = value.get("idiom").and_then(|v| v.as_str()) {
        env.idiom = match idiom {
            "desktop" => Idiom::Desktop,
            "pad" => Idiom::Pad,
            _ => Idiom::Phone,
        };
    }
    if let Some(locale) = value
        .get("locale")
        .and_then(|v| v.as_str())
        .and_then(nsh_core::platform::Locale::parse)
    {
        env.locale = locale;
    }
    env.rtl = flag("rtl").unwrap_or(env.rtl);
    env.apple_keyboard = flag("appleKeyboard").unwrap_or(env.apple_keyboard);
    env.reduce_motion = flag("reduceMotion").unwrap_or(env.reduce_motion);
    if let Some(scale) = num("fontScale").filter(|s| *s > 0.0) {
        env.font_scale = scale;
    }
    if let Some(ratio) = num("pixelRatio").filter(|r| *r > 0.0) {
        env.pixel_ratio = ratio;
    }
    if let Some([top, right, bottom, left]) = value
        .get("safeArea")
        .and_then(|v| v.as_array())
        .filter(|a| a.len() == 4)
        .map(|a| [0, 1, 2, 3].map(|i| a[i].as_f64().unwrap_or(0.0) as f32))
    {
        env.safe_area = nsh_core::Edges {
            top,
            right,
            bottom,
            left,
        }
        .map(|&v| nsh_core::Points(v));
    }
    env.keyboard_height = Points(num("keyboard").unwrap_or(env.keyboard_height.0));
    env.host = flag("host").unwrap_or(env.host);
    PAGE.with(|p| p.set(Some(env)));
    send(|app| {
        let e = &mut app.environment;
        e.locale = env.locale;
        e.rtl = env.rtl;
        e.apple_keyboard = env.apple_keyboard;
        e.reduce_motion = env.reduce_motion;
        e.font_scale = env.font_scale;
        e.pixel_ratio = env.pixel_ratio;
        e.safe_area = env.safe_area;
        e.keyboard_height = env.keyboard_height;
        app.control.set_environment(app.environment);
    })
}

/// Starts the app in `bundle` (JS source, an ES module as `nsh build`
/// writes it) in a `width` × `height` surface. Returns the delay (ms) until
/// [`nsh_pump`] is due, or -1.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_start(
    ptr: *const u8,
    len: usize,
    width: f32,
    height: f32,
    dark: u32,
    pixel_ratio: f32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let code = unsafe { string(ptr, len) };
    start(BundleCode::Source(code), width, height, dark, pixel_ratio)
}

/// [`nsh_start`] for a bundle compiled to QuickJS bytecode (`bundle.nshc`
/// from `nsh build`; what `nsh package --target web` ships). The runtime of
/// published apps (feature `bytecode-only`) runs nothing else.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`] holding bytecode the CLI
/// of this runtime's `nsh_js::BYTECODE_VERSION` wrote: QuickJS trusts it.
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_start_bytecode(
    ptr: *const u8,
    len: usize,
    width: f32,
    height: f32,
    dark: u32,
    pixel_ratio: f32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let code = unsafe { bytes(ptr, len) }.to_vec();
    start(BundleCode::Bytecode(code), width, height, dark, pixel_ratio)
}

/// Starts the Rust app this module was built for ([`rust_app!`]) in a
/// `width` × `height` surface: its root component, with no bundle. Returns
/// the delay (ms) until [`nsh_pump`] is due, or -1 (no app is registered).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_start_rust(width: f32, height: f32, dark: u32, pixel_ratio: f32) -> f64 {
    init();
    let Some(root) = ROOT.with(|r| r.borrow().as_ref().map(|make| make())) else {
        ffi::report_error("this runtime has no Rust app (`rust_app!`)");
        return -1.0;
    };
    APP.with(|a| a.borrow_mut().take());
    let environment = environment(width, height, dark != 0, pixel_ratio);
    run(
        App::Rust(root),
        width,
        height,
        environment,
        Limits::standalone(),
    )
}

/// Sets up logging and panics once.
fn init() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Info);
        std::panic::set_hook(Box::new(|info| {
            ffi::report_error(&format!("nsh panicked: {info}"));
        }));
    });
}

#[cfg(feature = "js")]
fn start(code: BundleCode, width: f32, height: f32, dark: u32, pixel_ratio: f32) -> f64 {
    init();
    APP.with(|a| a.borrow_mut().take());
    let environment = environment(width, height, dark != 0, pixel_ratio);
    let options = OPTIONS.with(|o| std::mem::take(&mut *o.borrow_mut()));
    let policy = if options.release {
        Policy::default()
    } else {
        Policy::development()
    };
    let mut bundle = match code {
        BundleCode::Source(code) => Bundle::source(code),
        // SAFETY: trusted, per `nsh_start_bytecode`'s contract.
        BundleCode::Bytecode(bytes) => unsafe { Bundle::bytecode(bytes) },
    }
    .with_policy(policy);
    if let Some(harden) = options.harden {
        // SAFETY: trusted, per `nsh_bundle_harden`'s contract.
        bundle = unsafe { bundle.with_harden_bytecode(harden) };
    }
    if let Some(map) = options.source_map {
        bundle = bundle.with_source_map(map);
    }
    let mut bundle = match bundle.with_capabilities_json(options.capabilities.as_deref()) {
        Ok(bundle) => bundle,
        Err(err) => {
            ffi::report_error(&err);
            return -1.0;
        }
    };
    let limits = match Limits::development(options.limits.as_deref()) {
        Ok(limits) => limits,
        Err(err) => {
            ffi::report_error(&format!("invalid limits: {err}"));
            return -1.0;
        }
    };
    bundle.base_url = BASE_URL.with(|b| b.borrow().as_deref().map(Into::into));
    let bundle = bundle.with_app_id(options.app_id.as_deref());
    run(App::Js(bundle), width, height, environment, limits)
}

/// Starts `app` in the page's surface.
fn run(app: App, width: f32, height: f32, environment: Environment, limits: Limits) -> f64 {
    let storage =
        BASE_URL.with(|b| storage::LocalStorage::new(app.app_id(), b.borrow().as_deref()));
    let namespace = BASE_URL.with(|b| {
        nsh_engine::local_storage_prefix(app.app_id(), b.borrow().as_deref().unwrap_or(""))
    });
    #[allow(unused_mut)]
    let mut config = EngineConfig {
        app,
        viewport: Size::new(Points(width), Points(height)),
        trace: false,
        network: Some(std::sync::Arc::new(net::WebNetwork)),
        websocket: Some(std::sync::Arc::new(websocket::BrowserWebSocket)),
        assets: Some(std::sync::Arc::new(PageAssets)),
        environment,
        // NSH draws no header: a page's `header` sits at its top.
        header_heights: nsh_core::NO_NATIVE_HEADER,
        limits,
        ui_sets: ui_sets(),
        runtime: None,
        data_dir: Some("/app-data".into()),
        // The browser keeps what it downloads in its HTTP cache.
        cache: nsh_engine::CacheOptions::off(),
        filesystem: Some(std::sync::Arc::new(filesystem::BrowserFileSystem {
            namespace,
        })),
        storage: Some(std::sync::Arc::new(storage)),
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    // A test session's app: the test's storage, network and trace.
    #[cfg(feature = "dev")]
    TEST_MODEL.with(|m| {
        if let Some(model) = &*m.borrow() {
            model.set_up_engine(&mut config);
        }
    });
    let text = Rc::new(WebTextEngine::default());
    let Some(mut engine) = LocalEngine::start(config, text.clone(), Sink) else {
        return -1.0;
    };
    // A task woken by a browser callback (a WebSocket message in an app's
    // crate, through wasm-bindgen) asks the page to pump, as input does.
    engine.set_wake(std::sync::Arc::new(ffi::request_pump));
    let control = engine.control();
    // The test moves its clock through the engine.
    #[cfg(feature = "dev")]
    TEST_MODEL.with(|m| {
        if let Some(model) = &*m.borrow() {
            model.engine_started(control.clone());
        }
    });
    APP.with(|a| {
        *a.borrow_mut() = Some(Running {
            engine,
            text,
            control,
            animation: UiAnimation::default(),
            js_frame: false,
            environment,
            inline_images: Default::default(),
        });
    });
    pump()
}

/// Sets the page's URL (`document.baseURI`): relative request URLs
/// (`fetch("/api")`) of the apps started next resolve against it.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_set_base_url(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let url = unsafe { string(ptr, len) };
    BASE_URL.with(|b| *b.borrow_mut() = Some(url));
}

/// Sets how the next [`nsh_start`] runs its bundle: as a release
/// (`release` 1: hardened, as `nsh package --target web` ships apps) or
/// with development settings (0, the default), under the capabilities the
/// app declares (`capabilities.json`; empty: no declaration), with the
/// bundle's source map (empty: none) and the app's id (`nsh.json` `"id"`,
/// which names where it keeps its data; empty: none, its page's path does).
///
/// # Safety
///
/// The three ranges are memory from [`nsh_alloc`].
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_bundle_options(
    release: u32,
    capabilities: *const u8,
    capabilities_len: usize,
    map: *const u8,
    map_len: usize,
    app_id: *const u8,
    app_id_len: usize,
) {
    // SAFETY: guaranteed by the caller.
    let (capabilities, map, app_id) = unsafe {
        (
            string(capabilities, capabilities_len),
            string(map, map_len),
            string(app_id, app_id_len),
        )
    };
    OPTIONS.with(|o| {
        *o.borrow_mut() = BundleOptions {
            release: release != 0,
            capabilities: (!capabilities.is_empty()).then_some(capabilities),
            source_map: (!map.is_empty()).then_some(map),
            harden: None,
            app_id: (!app_id.is_empty()).then_some(app_id),
            limits: None,
        }
    });
}

/// Sets the VM limits the next [`nsh_start`] / [`nsh_start_bytecode`]
/// (after [`nsh_bundle_options`]) runs the app with, as an embedding app
/// sets them (`nsh_core::js::HostLimits`' syntax, `memory=128MB,call=2s`;
/// empty: the embedding defaults): the page decides, as the playground
/// does for the code it runs. Without a call: none, as an app on its own.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_bundle_limits(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let limits = unsafe { string(ptr, len) };
    OPTIONS.with(|o| o.borrow_mut().limits = Some(limits));
}

/// Sets the hardening the next [`nsh_start`] / [`nsh_start_bytecode`] of a
/// release ([`nsh_bundle_options`]) runs, as bytecode
/// (`nsh_js::compile_harden`, which `nsh package` ships with the app): the
/// runtime of published apps cannot compile it.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`] holding what the CLI of
/// this runtime's `nsh_js::BYTECODE_VERSION` compiled.
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_bundle_harden(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let harden = unsafe { bytes(ptr, len) }.to_vec();
    OPTIONS.with(|o| o.borrow_mut().harden = Some(harden));
}

/// Applies a development update (a script from the dev server's hot
/// updates, named `name` in stack traces, with its source map or none)
/// to the running app. Returns the pump delay; [`nsh_hot_failed`] then
/// tells whether the app must be loaded again instead.
///
/// # Safety
///
/// The three ranges are memory from [`nsh_alloc`].
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_hot_update(
    name: *const u8,
    name_len: usize,
    code: *const u8,
    code_len: usize,
    map: *const u8,
    map_len: usize,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let (name, code, map) = unsafe {
        (
            string(name, name_len),
            string(code, code_len),
            string(map, map_len),
        )
    };
    HOT_FAILED.with(|f| f.set(false));
    let update = HotUpdate {
        name,
        code,
        source_map: (!map.is_empty()).then(|| map.into()),
    };
    send(|app| app.control.hot_update(update))
}

/// Whether the last [`nsh_hot_update`] could not be applied in place (1):
/// the app must be started again with the new bundle.
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_hot_failed() -> u32 {
    HOT_FAILED.with(|f| f.replace(false)) as u32
}

/// Hands over chunk `id` of a split bundle that the page fetched after
/// `load_chunk` (`ok` 1: `code` is its source; 2: its bytecode, from the
/// CLI as for [`nsh_start_bytecode`]; 0: `code` says why it could not be
/// loaded). Returns the pump delay.
///
/// # Safety
///
/// Both ranges are memory from [`nsh_alloc`]; bytecode (`ok` 2) is
/// trusted as in [`nsh_start_bytecode`].
#[cfg(feature = "js")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_chunk(
    id: *const u8,
    id_len: usize,
    code: *const u8,
    code_len: usize,
    ok: u32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let (id, code) = unsafe { (string(id, id_len), bytes(code, code_len)) };
    let chunk = match ok {
        0 => Err(String::from_utf8_lossy(code).into_owned()),
        // SAFETY: trusted, per the contract.
        2 => Ok(unsafe { Chunk::bytecode(id.clone(), code.to_vec()) }),
        _ => Ok(Chunk::source(
            id.clone(),
            String::from_utf8_lossy(code).into_owned(),
        )),
    };
    send(|app| match chunk {
        Ok(chunk) => app.control.chunk_loaded(chunk),
        Err(why) => app.control.chunk_failed(id, why),
    })
}

/// Compiles one module (`name`'s extension says TSX, TS, JSX or JS) to the
/// ES module [`nsh_start`] runs, for the playground. Returns 1 when it
/// compiled, 0 for an error; [`nsh_compiled_ptr`] / [`nsh_compiled_len`]
/// give the module or the error text.
///
/// # Safety
///
/// Both ranges are memory from [`nsh_alloc`].
#[cfg(feature = "compiler")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_compile(
    name: *const u8,
    name_len: usize,
    ptr: *const u8,
    len: usize,
) -> u32 {
    // SAFETY: guaranteed by the caller.
    let (name, source) = unsafe { (string(name, name_len), string(ptr, len)) };
    let sets: Vec<nsh_core::ui::description::SetDescription> = ui_sets()
        .iter()
        .flat_map(nsh_core::ui::Registry::sets)
        .filter_map(nsh_core::ui::description::SetDescription::of)
        .collect();
    let result = nsh_bundler::compile_module(&name, &source, &sets);
    let ok = result.is_ok();
    COMPILED.with(|c| *c.borrow_mut() = result.unwrap_or_else(|e| e));
    ok as u32
}

/// Where the text of the last [`nsh_compile`] starts.
#[cfg(feature = "compiler")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_compiled_ptr() -> *const u8 {
    COMPILED.with(|c| c.borrow().as_ptr())
}

/// The length of the text of the last [`nsh_compile`] in bytes.
#[cfg(feature = "compiler")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_compiled_len() -> usize {
    COMPILED.with(|c| c.borrow().len())
}

/// The server runs a test session (`nsh test --target web`): the app's
/// model is kept from the next bundle on, for [`nsh_test_answer`].
#[cfg(feature = "dev")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_test_start() {
    TEST_MODEL.with(|m| {
        m.borrow_mut()
            .get_or_insert_with(|| std::sync::Arc::new(nsh_testing::agent::Model::default()));
    });
}

/// Answers a test step (JSON `nsh_dev::protocol::TestStep`, `len` bytes at
/// `ptr`) from the app's model: the answer's length in bytes, its JSON at
/// [`nsh_test_answer_ptr`]: `{"done": value}`, `{"failed": message}`, or
/// `{"page": true}` when the page's views answer it (where a view is, the
/// viewport, an input's text, a dialog's buttons).
///
/// # Safety
///
/// `ptr` points at `len` bytes from [`nsh_alloc`].
#[cfg(feature = "dev")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_test_answer(ptr: *const u8, len: usize) -> usize {
    // SAFETY: per the contract.
    let text = unsafe { string(ptr, len) };
    let answer = match serde_json::from_str::<nsh_dev::protocol::TestStep>(&text) {
        Err(e) => serde_json::json!({ "failed": format!("not a step: {e}") }),
        Ok(nsh_dev::protocol::TestStep::Scene {
            query: nsh_dev::protocol::SceneQuery::Animating,
        }) => {
            let animating =
                APP.with(|a| a.borrow().as_ref().is_some_and(|r| r.animation.animating()));
            serde_json::json!({ "done": animating })
        }
        Ok(step) => {
            let model = TEST_MODEL.with(|m| m.borrow().clone());
            let answer = match model.and_then(|m| nsh_testing::agent::answer(&m, &step)) {
                Some(Ok(value)) => serde_json::json!({ "done": value }),
                Some(Err(message)) => serde_json::json!({ "failed": message }),
                None => serde_json::json!({ "page": true }),
            };
            // The engine runs on this thread: the clock gets there before the
            // step is answered, and the page then waits for what comes next.
            if let nsh_dev::protocol::TestStep::Scene {
                query: nsh_dev::protocol::SceneQuery::Clock { .. },
            } = step
            {
                pump();
                ffi::request_pump();
            }
            answer
        }
    };
    TEST_ANSWER.with(|a| {
        let mut a = a.borrow_mut();
        *a = answer.to_string();
        a.len()
    })
}

/// What the test sets the app up with (JSON `{"storage": [[key, value], …],
/// "trace": bool, "environment": {…}}`, a
/// `nsh_dev::protocol::ServerMessage::TestSetup`'s fields, `len` bytes at
/// `ptr`): the storage it starts with, whether it traces the app, and what
/// it fixes of the environment and the clipboard; its requests, and a traced app's batches, go to the
/// test over the page's socket from then on.
///
/// # Safety
///
/// `ptr` points at `len` bytes from [`nsh_alloc`].
#[cfg(feature = "dev")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_test_setup(ptr: *const u8, len: usize) {
    // SAFETY: per the contract.
    let text = unsafe { string(ptr, len) };
    let mut setup: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let storage: Vec<(String, String)> =
        serde_json::from_value(setup["storage"].take()).unwrap_or_default();
    let trace = setup["trace"].as_bool().unwrap_or(false);
    let environment = serde_json::from_value(setup["environment"].take()).unwrap_or_default();
    let model = TEST_MODEL.with(|m| m.borrow().clone());
    if let Some(model) = model {
        model.set_up(
            storage,
            trace,
            environment,
            std::sync::Arc::new(|message: nsh_testing::agent::Outgoing| {
                if let Ok(json) = serde_json::to_string(&message.into_message()) {
                    ffi::test_send(&json);
                }
            }),
        );
    }
}

/// The test's answer to the app's request (JSON `{"id": n, "reply": …}`,
/// a `nsh_dev::protocol::ServerMessage::Fetch`'s fields, `len` bytes at
/// `ptr`).
///
/// # Safety
///
/// `ptr` points at `len` bytes from [`nsh_alloc`].
#[cfg(feature = "dev")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_test_fetch_reply(ptr: *const u8, len: usize) {
    // SAFETY: per the contract.
    let text = unsafe { string(ptr, len) };
    let Ok(mut wire) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let id = wire["id"].as_u64();
    let reply = serde_json::from_value::<nsh_dev::protocol::FetchReply>(wire["reply"].take());
    let model = TEST_MODEL.with(|m| m.borrow().clone());
    if let (Some(model), Some(id), Ok(reply)) = (model, id, reply) {
        model.fetch_reply(id, reply);
    }
}

/// Where the text of the last [`nsh_test_answer`] starts.
#[cfg(feature = "dev")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_test_answer_ptr() -> *const u8 {
    TEST_ANSWER.with(|a| a.borrow().as_ptr())
}

/// Stops the app.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_stop() {
    APP.with(|a| a.borrow_mut().take());
    KEYMAP.with(|k| k.borrow_mut().take());
    BATCHES.with(|b| b.borrow_mut().clear());
}

/// Applies the submitted batches: animation items to the animator, the
/// rest to the DOM.
fn flush() {
    let batches = BATCHES.with(|b| std::mem::take(&mut *b.borrow_mut()));
    if batches.is_empty() {
        request_frames();
        return;
    }
    let retirements = APP.with(|a| {
        let mut app = a.borrow_mut();
        let Some(app) = app.as_mut() else { return None };
        let mut out = Out::new();
        for batch in &batches {
            for item in &batch.items {
                app.animation.apply(item);
                if let MountItem::Keymap(keymap) = item {
                    let keymap = (!keymap.is_empty()).then(|| keymap.clone());
                    KEYMAP.with(|k| *k.borrow_mut() = keymap);
                    continue;
                }
                if let MountItem::Image {
                    source, options, ..
                } = item
                {
                    for source in source.iter().chain(&options.placeholder) {
                        if let Some(data) = &source.data
                            && app.inline_images.register(source)
                        {
                            ffi::image_bytes(&source.uri, data);
                        }
                    }
                }
                if !matches!(
                    item,
                    MountItem::Animation(_) | MountItem::AnimationBindings { .. }
                ) {
                    encode::encode(&mut out, item);
                }
            }
        }
        for uri in app.inline_images.prune() {
            ffi::release_image(&uri);
        }
        // Bound properties follow the styles just applied.
        app.animation.outputs(&mut out);
        let retired = if out.is_empty() {
            Vec::new()
        } else {
            ffi::submit(&out.finish())
        };
        finish_animations(app);
        Some((app.control.clone(), retired))
    });
    if let Some((control, retirements)) = retirements {
        let changed = !retirements.is_empty();
        for retired in retirements {
            control.set_focus_path(retired.focus);
            for contact in retired.cancelled {
                control.cancel_touch(contact);
            }
            for (id, states) in retired.states {
                control.set_states(id, states);
            }
            control.retire_list_cell(
                retired.id,
                retired
                    .request
                    .parse()
                    .expect("invalid DOM retirement request"),
                retired.retired,
            );
        }
        if changed {
            ffi::request_pump();
        }
    }
    request_frames();
}

fn finish_animations(app: &mut Running) {
    if !app.animation.finished.is_empty() {
        let finished = std::mem::take(&mut app.animation.finished);
        app.control.animations_finished(finished);
    }
}

fn request_frames() {
    let wanted = FRAME_REQUESTED.with(|f| f.replace(false));
    let animating = APP.with(|a| {
        let mut app = a.borrow_mut();
        let Some(app) = app.as_mut() else {
            return false;
        };
        app.js_frame |= wanted;
        app.js_frame || app.animation.animating()
    });
    if animating {
        ffi::request_frame();
    }
}

/// Runs the engine; the delay (ms) until it is due again, or -1.
fn pump() -> f64 {
    let deadline = APP.with(|a| {
        let mut app = a.borrow_mut();
        app.as_mut().map(|app| app.engine.pump())
    });
    flush();
    match deadline.flatten() {
        Some(at) => {
            at.saturating_duration_since(nsh_core::time::Instant::now())
                .as_secs_f64()
                * 1000.0
        }
        None => -1.0,
    }
}

/// Runs what is due; returns the delay (ms) until it is due again, or -1.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_pump() -> f64 {
    pump()
}

fn send(f: impl FnOnce(&mut Running)) -> f64 {
    APP.with(|a| {
        if let Some(app) = a.borrow_mut().as_mut() {
            f(app);
        }
    });
    pump()
}

/// A display frame (`requestAnimationFrame`, `now` in ms): ticks the
/// native animations and runs JS's frame callbacks. Returns the pump
/// delay.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_frame(now: f64) -> f64 {
    APP.with(|a| {
        let mut app = a.borrow_mut();
        let Some(app) = app.as_mut() else { return };
        if app.animation.animating() {
            // The animation graph's clock is in seconds.
            app.animation.tick(now / 1000.0);
            let mut out = Out::new();
            app.animation.outputs(&mut out);
            if !out.is_empty() {
                let _ = ffi::submit(&out.finish());
            }
            finish_animations(app);
        }
        if std::mem::take(&mut app.js_frame) {
            app.control.frame();
        }
    });
    pump()
}

/// An event on view `id`, named by its prop (`onPress`), with its payload
/// as JSON (an object or null).
///
/// # Safety
///
/// `name..name + name_len` and `ptr..ptr + len` are memory from
/// [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_event(
    id: u32,
    name: *const u8,
    name_len: usize,
    ptr: *const u8,
    len: usize,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let name = unsafe { string(name, name_len) };
    let Some(kind) = EventKind::from_prop(&name) else {
        return pump();
    };
    // SAFETY: guaranteed by the caller.
    let json = unsafe { string(ptr, len) };
    let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
    let num = |k: &str| value.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
    let text = |k: &str| {
        value
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let payload = match kind {
        EventKind::ScrollEnd
        | EventKind::ScrollDragStart
        | EventKind::ScrollDragEnd
        | EventKind::MomentumStart
        | EventKind::MomentumEnd => EventPayload::Scroll(point(Points(num("x")), Points(num("y")))),
        // A video's and a web view's loads carry more than an image's.
        EventKind::Load if value.get("duration").is_none() && value.get("url").is_none() => {
            // `naturalWidth` / `naturalHeight`: whole pixels.
            EventPayload::Image(size(
                DevicePixels(num("width") as i32),
                DevicePixels(num("height") as i32),
            ))
        }
        EventKind::Error => EventPayload::Error {
            message: text("message"),
        },
        EventKind::HoverMove | EventKind::ContextMenu => {
            // `{ position, pagePosition, modifiers }`, as handlers get it.
            let at = |k: &str| {
                let p = value.get(k);
                let n = |c: &str| {
                    p.and_then(|p| p.get(c))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0) as f32
                };
                point(Points(n("x")), Points(n("y")))
            };
            let flag = |k: &str| {
                value
                    .get("modifiers")
                    .and_then(|m| m.get(k))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            };
            let (position, page_position) = (at("position"), at("pagePosition"));
            let modifiers = nsh_core::keymap::Modifiers {
                ctrl: flag("control"),
                alt: flag("alt"),
                shift: flag("shift"),
                cmd: flag("platform"),
            };
            if kind == EventKind::HoverMove {
                EventPayload::Hover(nsh_core::HoverEvent {
                    position,
                    page_position,
                    modifiers,
                })
            } else {
                EventPayload::ContextMenu(nsh_core::ContextMenuEvent {
                    position,
                    page_position,
                    modifiers,
                })
            }
        }
        EventKind::ChangeText | EventKind::SubmitEditing => EventPayload::Text {
            text: text("text"),
            count: num("count") as u32,
        },
        // `{ bounds: { origin, size } }`, as handlers get it.
        EventKind::CaretMove => {
            let caret = value.get("bounds");
            let n = |part: &str, c: &str| {
                caret
                    .and_then(|v| v.get(part))
                    .and_then(|v| v.get(c))
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0) as f32
            };
            EventPayload::caret(nsh_core::Bounds {
                origin: point(Points(n("origin", "x")), Points(n("origin", "y"))),
                size: size(Points(n("size", "width")), Points(n("size", "height"))),
            })
        }
        EventKind::Host => EventPayload::Json(value),
        _ => match &value {
            serde_json::Value::Object(map) => EventPayload::Map(
                map.iter()
                    .filter_map(|(k, v)| {
                        // Payload keys are static in the core: intern the
                        // known ones.
                        let key: &'static str = match k.as_str() {
                            "key" => "key",
                            "start" => "start",
                            "end" => "end",
                            "id" => "id",
                            "index" => "index",
                            "data" => "data",
                            "actionName" => "actionName",
                            "currentTime" => "currentTime",
                            "duration" => "duration",
                            "isBuffering" => "isBuffering",
                            "width" => "width",
                            "height" => "height",
                            "top" => "top",
                            "right" => "right",
                            "bottom" => "bottom",
                            "left" => "left",
                            "text" => "text",
                            "composing" => "composing",
                            "has" => "has",
                            "uri" => "uri",
                            "files" => "files",
                            "error" => "error",
                            "url" => "url",
                            "title" => "title",
                            "loading" => "loading",
                            "canGoBack" => "canGoBack",
                            "canGoForward" => "canGoForward",
                            "loaded" => "loaded",
                            "total" => "total",
                            _ => return None,
                        };
                        let v = match v {
                            serde_json::Value::Number(n) => {
                                PayloadValue::Number(n.as_f64().unwrap_or(0.0))
                            }
                            serde_json::Value::Bool(b) => PayloadValue::Bool(*b),
                            serde_json::Value::String(s) => PayloadValue::Str(s.clone()),
                            _ => return None,
                        };
                        Some((key, v))
                    })
                    .collect(),
            ),
            _ => EventPayload::None,
        },
    };
    send(|app| app.control.dispatch_event(id, kind, payload))
}

/// `onPaste` of input `id`: what the user pasted, as JSON `{ text, files:
/// [{ name, type, size }], uris }` and the files' bytes one after the other
/// (they never cross as JS strings).
///
/// # Safety
///
/// `ptr..ptr + len` and `data..data + data_len` are memory from
/// [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_paste(
    id: u32,
    ptr: *const u8,
    len: usize,
    data: *const u8,
    data_len: usize,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let json = unsafe { string(ptr, len) };
    // SAFETY: guaranteed by the caller.
    let bytes: &[u8] = if data_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data, data_len) }
    };
    let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
    let text = |v: &serde_json::Value, k: &str| {
        v.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let mut paste = nsh_core::PasteEvent::new(text(&value, "text"));
    let mut at = 0usize;
    for file in value
        .get("files")
        .and_then(|f| f.as_array())
        .into_iter()
        .flatten()
    {
        let size = file.get("size").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
        let Some(part) = bytes.get(at..at + size) else {
            break;
        };
        at += size;
        paste.files.push(nsh_core::PastedFile::new(
            text(file, "name"),
            text(file, "type"),
            part.to_vec(),
        ));
    }
    paste.uris = value
        .get("uris")
        .and_then(|u| u.as_array())
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_str().map(str::to_owned))
        .collect();
    send(|app| {
        app.control
            .dispatch_event(id, EventKind::Paste, EventPayload::Paste(Box::new(paste)))
    })
}

thread_local! {
    /// The files of the pick `nsh.js` is answering ([`nsh_picked_file`]).
    static PICKED: RefCell<Vec<nsh_core::picker::PickedFile>> = const { RefCell::new(Vec::new()) };
}

/// A file picked for the pick `nsh.js` is answering (`Picker.pickImages`):
/// its name, its type, its bytes, its size in pixels (0: unknown) and when
/// it was last changed (ms since the Unix epoch). [`nsh_picked`] sends them.
///
/// # Safety
///
/// The three ranges are memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn nsh_picked_file(
    name: *const u8,
    name_len: usize,
    mime: *const u8,
    mime_len: usize,
    ptr: *const u8,
    len: usize,
    width: u32,
    height: u32,
    last_modified: f64,
) {
    // SAFETY: guaranteed by the caller.
    let (name, mime, data) = unsafe {
        (
            string(name, name_len),
            string(mime, mime_len),
            bytes(ptr, len).to_vec(),
        )
    };
    let mut file = nsh_core::picker::PickedFile::new(name, mime, nsh_core::ImageData::new(data));
    if width > 0 && height > 0 {
        file.size = size(DevicePixels(width as i32), DevicePixels(height as i32));
    }
    if last_modified.is_finite() && last_modified >= 0.0 {
        file.last_modified =
            Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(last_modified as u64));
    }
    PICKED.with_borrow_mut(|files| files.push(file));
}

/// Answers pick `request` with the files [`nsh_picked_file`] gave (none:
/// cancelled).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_picked(request: u32) -> f64 {
    let files = PICKED.with_borrow_mut(std::mem::take);
    send(|app| {
        app.control.dispatch_event(
            ROOT_ID,
            EventKind::Pick,
            EventPayload::Picked { id: request, files },
        )
    })
}

/// Touches, as JSON `{ phase, time, points: [{ id, target, path, pageX,
/// pageY, x, y, changed }] }` (`phase`: 0 start, 1 move, 2 end, 3
/// cancel).
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_touch(ptr: *const u8, len: usize) -> f64 {
    // SAFETY: guaranteed by the caller.
    let json = unsafe { string(ptr, len) };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return pump();
    };
    let f = |v: &serde_json::Value, k: &str| v.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let phase = match f(&value, "phase") as u32 {
        0 => nsh_core::TouchPhase::Start,
        1 => nsh_core::TouchPhase::Move,
        2 => nsh_core::TouchPhase::End,
        _ => nsh_core::TouchPhase::Cancel,
    };
    let points = value
        .get("points")
        .and_then(|p| p.as_array())
        .map(|points| {
            points
                .iter()
                .map(|p| nsh_core::TouchPoint {
                    id: f(p, "id") as u32,
                    target: f(p, "target") as u32,
                    path: p
                        .get("path")
                        .and_then(|p| p.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_u64())
                                .map(|v| v as u32)
                                .collect()
                        })
                        .unwrap_or_default(),
                    page: point(Points(f(p, "pageX") as f32), Points(f(p, "pageY") as f32)),
                    location: point(Points(f(p, "x") as f32), Points(f(p, "y") as f32)),
                    changed: p.get("changed").and_then(|v| v.as_bool()).unwrap_or(true),
                })
                .collect()
        })
        .unwrap_or_default();
    let event = nsh_core::TouchEvent {
        phase,
        timestamp: f(&value, "time"),
        points,
        activated: value
            .get("activated")
            .and_then(|v| v.as_u64())
            .map(|v| v as nsh_core::NodeId),
    };
    send(|app| {
        app.control.dispatch_event(
            ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(event)),
        )
    })
}

/// The key [`nsh_key`] gets: a printable ASCII character's code (as
/// typed without Shift on the US layout), or one of these past 255.
fn key_of(code: u32) -> Option<Key> {
    Some(match code {
        0x20..=0x7e => Key::Char((code as u8 as char).to_ascii_lowercase()),
        256 => Key::Enter,
        257 => Key::Escape,
        258 => Key::Tab,
        259 => Key::Backspace,
        260 => Key::Delete,
        261 => Key::Insert,
        262 => Key::Up,
        263 => Key::Down,
        264 => Key::Left,
        265 => Key::Right,
        266 => Key::Home,
        267 => Key::End,
        268 => Key::PageUp,
        269 => Key::PageDown,
        // F1 to F24.
        513..=536 => Key::F((code - 512) as u8),
        _ => return None,
    })
}

/// Matches a key against the app's shortcuts (`nsh/keymap`) on the spot,
/// while the browser's key event is handled: `key` as [`key_of`] takes
/// it, `modifiers` bits 1 Ctrl, 2 Alt, 4 Shift, 8 Meta (Command, the
/// Windows key), `editing` when a text field has the focus, `repeat` for
/// an auto-repeat. Returns the binding that fires, -1 for none (the key
/// goes on) or -2 for a held key's repeat (consumed, nothing fires). JS
/// reports a firing binding with [`nsh_key_command`].
///
/// `f64` keeps every `u32` binding ID positive in JS, including Rust
/// shortcuts (`1 << 31` and up) and overlay Escape (`u32::MAX`), while
/// leaving the negative sentinels distinct.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_key(key: u32, modifiers: u32, editing: u32, repeat: u32) -> f64 {
    let Some(key) = key_of(key) else { return -1.0 };
    let keystroke = Keystroke {
        modifiers: Modifiers {
            ctrl: modifiers & 1 != 0,
            alt: modifiers & 2 != 0,
            shift: modifiers & 4 != 0,
            cmd: modifiers & 8 != 0,
        },
        key,
    };
    let found = KEYMAP.with(|k| {
        k.borrow().as_ref().map_or(KeyMatch::None, |k| {
            k.find(keystroke, editing != 0, repeat != 0)
        })
    });
    match found {
        KeyMatch::None => -1.0,
        KeyMatch::Held => -2.0,
        KeyMatch::Fire(id) => id as f64,
    }
}

/// Binding `id` of the app's shortcuts fired ([`nsh_key`]): the root's
/// `onKeyCommand`.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_key_command(id: u32) -> f64 {
    send(|app| {
        app.control.dispatch_event(
            ROOT_ID,
            EventKind::KeyCommand,
            EventPayload::Value(PayloadValue::Number(id as f64)),
        )
    })
}

/// A scroll view's offset changed (`applied`: the scrolls the core asked
/// for that were applied before it).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_scroll(id: u32, x: f32, y: f32, applied: u32) -> f64 {
    send(|app| {
        if app.animation.scrolled(id, x, y) {
            let mut out = Out::new();
            app.animation.outputs(&mut out);
            if !out.is_empty() {
                let _ = ffi::submit(&out.finish());
            }
        }
        app.control.scroll(id, point(px(x), px(y)), applied);
    })
}

/// Scroll view `id` came to rest (`onScrollEnd`, sent or not): the snapping
/// animated values that follow it settle.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_scroll_ended(id: u32) -> f64 {
    send(|app| app.animation.scroll_ended(id))
}

/// The user zoomed zoomable scroll view `id` to `scale` (reported before
/// the offset it scrolled to).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_zoom(id: u32, scale: f32) -> f64 {
    send(|app| app.control.zoom(id, scale))
}

/// A drag on a view with native pan values (`phase`: 0 start, 1 move, 2
/// end), translated `(tx, ty)` since it began, at velocity `(vx, vy)`
/// points per second.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_pan(id: u32, phase: u32, tx: f32, ty: f32, vx: f32, vy: f32) -> f64 {
    send(|app| {
        match phase {
            0 => app.animation.pan_began(id),
            _ => app.animation.pan_moved(id, tx, ty),
        }
        let mut out = Out::new();
        app.animation.outputs(&mut out);
        if !out.is_empty() {
            let _ = ffi::submit(&out.finish());
        }
        let (value_x, value_y) = app.animation.pan_values(id);
        let payload = if phase == 3 {
            EventPayload::PanCancelled {
                translation: point(Points(tx), Points(ty)),
                velocity_x: vx,
                velocity_y: vy,
                value_x: value_x.map(Points),
                value_y: value_y.map(Points),
            }
        } else {
            EventPayload::Pan {
                translation: point(Points(tx), Points(ty)),
                velocity_x: vx,
                velocity_y: vy,
                value_x: value_x.map(Points),
                value_y: value_y.map(Points),
            }
        };
        match phase {
            0 => app.control.dispatch_event(id, EventKind::PanStart, payload),
            2 | 3 => app.control.dispatch_event(id, EventKind::PanEnd, payload),
            _ => {}
        }
    })
}

/// A pinch (`rotation` 0; `amount`: the scale since it began) or rotation
/// (1; degrees) on a view with animated values (`phase`: 0 start, 1 move, 2
/// end).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_transform_gesture(id: u32, rotation: u32, phase: u32, amount: f32) -> f64 {
    let rotation = rotation != 0;
    send(|app| {
        match phase {
            0 => app.animation.transform_began(id, rotation),
            _ => app.animation.transform_moved(id, rotation, amount),
        }
        let mut out = Out::new();
        app.animation.outputs(&mut out);
        if !out.is_empty() {
            let _ = ffi::submit(&out.finish());
        }
        let key = if rotation { "rotation" } else { "scale" };
        let payload = EventPayload::Map(vec![
            (key, PayloadValue::Number(amount as f64)),
            ("velocity", PayloadValue::Number(0.0)),
        ]);
        let kind = match (rotation, phase) {
            (false, 0) => Some(EventKind::PinchStart),
            (false, 2) => Some(EventKind::PinchEnd),
            (true, 0) => Some(EventKind::RotationStart),
            (true, 2) => Some(EventKind::RotationEnd),
            _ => None,
        };
        if let Some(kind) = kind {
            app.control.dispatch_event(id, kind, payload);
        }
    })
}

/// The platform presents root `id` (a screen or modal) at `width` ×
/// `height`, with insets covered by system UI.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_root_size(
    id: u32,
    width: f32,
    height: f32,
    top: f32,
    right: f32,
    bottom: f32,
    left: f32,
) -> f64 {
    send(|app| {
        let insets = nsh_core::EdgeInsets {
            top: Points(top),
            right: Points(right),
            bottom: Points(bottom),
            left: Points(left),
        };
        app.control
            .set_root_size(id, Size::new(Points(width), Points(height)), insets);
        let n = |v: f32| PayloadValue::Number(v as f64);
        app.control.dispatch_event(
            id,
            EventKind::Insets,
            EventPayload::Map(vec![
                ("top", n(top)),
                ("right", n(right)),
                ("bottom", n(bottom)),
                ("left", n(left)),
            ]),
        );
    })
}

/// The interaction states of view `id` (`active:`, `hover:`, `focus:`
/// classes).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_states(id: u32, states: u32) -> f64 {
    send(|app| app.control.set_states(id, states as u8))
}

/// The surface was resized (points).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_resize(width: f32, height: f32) -> f64 {
    send(|app| {
        app.environment.window =
            nsh_core::Size::new(nsh_core::Points(width), nsh_core::Points(height));
        app.control.resize(Size::new(Points(width), Points(height)));
        app.control.set_environment(app.environment);
    })
}

/// Fonts registered with `register_font` finished loading (`FontFace`
/// loads asynchronously): text measured with a fallback font before is
/// measured again.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_fonts_loaded() -> f64 {
    send(|app| {
        app.text.clear_caches();
        app.control.fonts_changed();
    })
}

/// The page switched between light and dark.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_set_dark(dark: u32) -> f64 {
    send(|app| {
        app.environment.color_scheme = if dark != 0 {
            ColorScheme::Dark
        } else {
            ColorScheme::Light
        };
        app.control.set_environment(app.environment);
    })
}
