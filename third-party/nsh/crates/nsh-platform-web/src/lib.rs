//! WebAssembly backend for nsh: runs an app in a browser page and renders
//! it to the DOM: apps published with `nsh package --target web`, the web
//! development host and the website's live demos. `platform.os` is `"web"`;
//! the page reports the idiom (phone, tablet or desktop browser), locale
//! and the user's settings ([`nsh_environment`]).
//!
//! - The app's TSX runs on the browser's own JavaScript engine (feature
//!   `browser`): the page imports its ES modules, which reach the Rust
//!   engine, reactive graph and components through `src/browser/`. The
//!   module has no JS interpreter of its own.
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
//! - What the module leaves out, the syntaxes code is highlighted with,
//!   comes from the page the first time it is needed ([`nsh_data`],
//!   `nsh_core::runtime_data`).
//!
//! There are no native components; web views are `<iframe>`s and scroll
//! views use the browser's scrolling. Off WebAssembly this crate is empty.

#![cfg(target_arch = "wasm32")]

#[cfg(feature = "browser-core")]
mod browser;

mod animation;
mod canvas;
mod encode;
mod event;
mod ffi;
mod filesystem;
mod net;
mod shader;
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
    App, Assets, ColorScheme, EngineConfig, EngineControl, Environment, Idiom, Lifecycle, Limits,
    LocalEngine, MountSink, Os,
};

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
    /// The launch parameters of the next app the page starts
    /// ([`nsh_set_host_params`]): its `host.params`.
    static HOST_PARAMS: RefCell<serde_json::Map<String, serde_json::Value>> = RefCell::new(serde_json::Map::new());
    /// The address the next app starts at ([`nsh_set_page_url`]).
    static PAGE_URL: RefCell<Option<String>> = const { RefCell::new(None) };
    /// What the page reported last ([`nsh_environment`]), kept for the
    /// next start ([`nsh_start_rust`], `nsh_browser_start`).
    static PAGE: Cell<Option<Environment>> = const { Cell::new(None) };
    /// The app's keyboard shortcuts (`MountItem::Keymap`), matched in
    /// [`nsh_key`] while a key event is being handled. Apart from [`APP`]
    /// so that matching never needs the engine.
    static KEYMAP: RefCell<Option<std::sync::Arc<Keymap>>> = const { RefCell::new(None) };
    /// The UI sets apps import ([`set_ui_sets`]; by default `nsh/base`).
    static UI_SETS: RefCell<Option<Vec<nsh_core::element::Registry>>> = const { RefCell::new(None) };
    /// The app's own UI sets their gates added ([`add_ui_set`], [`ui_set!`]),
    /// served after `nsh/base`'s parts.
    static APP_SETS: RefCell<Vec<nsh_core::element::Registry>> = const { RefCell::new(Vec::new()) };
    /// What makes the Rust app's root ([`set_root`]), for [`nsh_start_rust`].
    static ROOT: RefCell<Option<Box<dyn Fn() -> nsh_core::element::Root>>> = const { RefCell::new(None) };
    /// What the last [`nsh_compile`] made: the module or the error.
    #[cfg(feature = "compiler")]
    static COMPILED: RefCell<String> = const { RefCell::new(String::new()) };
}

/// What [`ui_sets!`] gives.
pub use nsh_core::element::Registry;

/// Sets the UI sets the apps started from now on serve: `nsh/base` and
/// an app's own Rust components (`nsh.json` `"rust"`). A runtime built for
/// the app ([`ui_sets!`]) passes them before the page starts anything.
pub fn set_ui_sets(sets: Vec<Registry>) {
    UI_SETS.with(|s| *s.borrow_mut() = Some(sets));
}

/// Adds one of the app's own UI sets to the apps started from now on,
/// after `nsh/base`'s parts ([`ui_set!`]'s gate calls it). A set added
/// again replaces nothing: the first stays.
pub fn add_ui_set(set: Registry) {
    APP_SETS.with(|s| {
        let mut sets = s.borrow_mut();
        if !sets.iter().any(|t| t.specifier() == set.specifier()) {
            sets.push(set);
        }
    });
}

/// The UI sets engines serve: [`set_ui_sets`]'s, else `nsh/base`'s parts
/// and the app's sets their gates added ([`add_ui_set`]).
fn ui_sets() -> Vec<Registry> {
    UI_SETS.with(|s| s.borrow().clone()).unwrap_or_else(|| {
        let mut sets = vec![base_set()];
        APP_SETS.with(|a| sets.extend(a.borrow().iter().cloned()));
        sets
    })
}

/// `nsh/base`: the parts the page asked for (`nsh_part_*`, which it calls
/// for each the module exports before it starts anything).
#[cfg(feature = "base-full")]
fn base_set() -> Registry {
    nsh_base::registry_of(PARTS.with(|p| p.borrow().clone()))
}

thread_local! {
    /// The `nsh/base` parts `nsh_part_*` asked for.
    #[cfg(feature = "base-full")]
    static PARTS: RefCell<Vec<nsh_base::parts::Part>> = const { RefCell::new(Vec::new()) };
}

/// Exports one `nsh_part_<name>` per part of `nsh/base`: the page calls
/// those of the parts its app uses, and a runtime linked for the app keeps
/// only the parts it exports. The list must name every part of
/// [`nsh_base::parts::ALL`] (checked at compile time): a part without its
/// gate is never registered, and an app importing one of its exports fails
/// to link ("does not provide an export named …").
macro_rules! base_parts {
    ($($name:ident => $export:ident),* $(,)?) => {
        #[cfg(feature = "base-full")]
        const _: () = assert!(
            covers_every_part(&[$(stringify!($name)),*]),
            "base_parts! must list every part of nsh_base::parts::ALL",
        );
        $(
        /// Adds this part of `nsh/base` to the apps started from now on.
        #[cfg(feature = "base-full")]
        #[unsafe(no_mangle)]
        pub extern "C" fn $export() {
            PARTS.with(|p| {
                let mut parts = p.borrow_mut();
                let part = nsh_base::parts::$name as nsh_base::parts::Part;
                if !parts.iter().any(|q| std::ptr::fn_addr_eq(*q, part)) {
                    parts.push(part);
                }
            });
        }
        )*
    };
}

/// Whether `names` are exactly the parts of [`nsh_base::parts::ALL`].
#[cfg(feature = "base-full")]
const fn covers_every_part(names: &[&str]) -> bool {
    const fn same(a: &str, b: &str) -> bool {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        let mut i = 0;
        while i < a.len() {
            if a[i] != b[i] {
                return false;
            }
            i += 1;
        }
        true
    }
    let all = nsh_base::parts::ALL;
    if names.len() != all.len() {
        return false;
    }
    let mut i = 0;
    while i < all.len() {
        let mut j = 0;
        let mut found = false;
        while j < names.len() {
            found |= same(all[i].0, names[j]);
            j += 1;
        }
        if !found {
            return false;
        }
        i += 1;
    }
    true
}

base_parts!(
    core => nsh_part_core,
    menu => nsh_part_menu,
    overlays => nsh_part_overlays,
    select => nsh_part_select,
    command => nsh_part_command,
    combobox => nsh_part_combobox,
    toast => nsh_part_toast,
    pickers => nsh_part_pickers,
    color_picker => nsh_part_color_picker,
    emoji_picker => nsh_part_emoji_picker,
    carousel => nsh_part_carousel,
    tree => nsh_part_tree,
    fields => nsh_part_fields,
    text_view => nsh_part_text_view,
    editor => nsh_part_editor,
    diff => nsh_part_diff,
    rich_editor => nsh_part_rich_editor,
    data_table => nsh_part_data_table,
    table => nsh_part_table,
    dock => nsh_part_dock,
    resizable => nsh_part_resizable,
    plot => nsh_part_plot,
    term => nsh_part_term,
);

/// Makes `TextView`'s formulas typeset: no app imports this. A published
/// runtime keeps it in a side module the page loads for the first formula.
#[cfg(feature = "base-full")]
#[unsafe(no_mangle)]
pub extern "C" fn nsh_feature_math() {
    nsh_base::text_view::install_math();
}

/// `nsh/base` in the lite runtime (feature `base-full` off): its controls
/// (the core and the parts split from it), so the larger parts' code stays
/// out of the module.
#[cfg(not(feature = "base-full"))]
fn base_set() -> Registry {
    use nsh_base::parts::{self, Part};
    nsh_base::registry_of([
        parts::core as Part,
        parts::menu,
        parts::overlays,
        parts::select,
        parts::command,
        parts::combobox,
        parts::toast,
        parts::pickers,
        parts::color_picker,
        parts::carousel,
        parts::tree,
        parts::fields,
    ])
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

/// Exports `$export`, the gate of one of the app's own UI sets (`$set`, an
/// expression giving its [`Registry`]): `nsh.js` calls it as it calls the
/// `nsh_part_*` of `nsh/base`'s parts, and a runtime linked for the app
/// (`nsh package`) keeps only the gates of the sets it imports. `nsh`
/// names it `nsh_ui_set_<specifier>` (non-alphanumerics as `_`).
#[macro_export]
macro_rules! ui_set {
    ($export:ident, $set:expr) => {
        /// Adds this UI set of the app to the apps started from now on.
        #[unsafe(no_mangle)]
        pub extern "C" fn $export() {
            $crate::add_ui_set($set);
        }
    };
}

/// Sets the Rust app [`nsh_start_rust`] runs: `root` makes its root
/// component (with its theme), each time the page starts it.
pub fn set_root(root: impl Fn() -> nsh_core::element::Root + 'static) {
    ROOT.with(|r| *r.borrow_mut() = Some(Box::new(root)));
}

/// Makes this module the web runtime of a Rust app (`nsh.json` `"root"`):
/// it serves `$sets` (`nsh/base` and the app's own set) and runs the
/// root component `$root` makes (an expression giving a
/// [`nsh_core::element::Root`]) when the page calls [`nsh_start_rust`]. Built
/// without the feature `browser-core`, the module runs no TSX: the app is
/// Rust from start to end. Exports `nsh_app_init`, as [`ui_sets!`].
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
}

/// Bundled files the page preloaded (fonts, images drawn on a canvas); the
/// others are downloaded from where the page serves them.
struct PageAssets;

impl Assets for PageAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        ffi::read_asset(uri).ok_or_else(|| format!("{uri} is not available on the web"))
    }

    fn url(&self, uri: &str) -> Option<String> {
        uri.starts_with("asset:/").then(|| ffi::asset_url(uri))
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
        // Browsers' screen readers follow `aria-activedescendant`.
        reads_active_descendants: true,
        ..Environment::default()
    })
}

/// What the page knows about the user and the device, as JSON: `idiom`
/// (`"phone"`, `"pad"`, `"desktop"`), `locale` (a BCP 47 tag), `rtl`,
/// `reduceMotion`, `fontScale`, `pixelRatio`, `safeArea` (`[top, right,
/// bottom, left]`), `keyboard` (the height the on-screen keyboard
/// covers), `appleKeyboard` (the browser runs on an Apple platform: its
/// shortcuts are Apple's), `host` (the page answers `nsh/host` calls:
/// `createPlayer`'s `host`) and `screenColor` (the browser has an
/// `EyeDropper`) and `shaders` (`false` once a shader view found no
/// WebGL 2); missing keys keep their value. Called before the app starts
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
    if let Some(languages) = value
        .get("languages")
        .and_then(|v| v.as_array())
        .and_then(|tags| {
            nsh_core::platform::Languages::parse(tags.iter().filter_map(|t| t.as_str()))
        })
    {
        env.locale_settings.languages = languages;
    }
    if let Some(regional) = value.get("regional") {
        // The region's preferences, with the browser's hour cycle and first
        // day of the week where it has them.
        let locale = regional.get("locale").and_then(|v| v.as_str());
        let parsed =
            nsh_core::platform::LocaleSettings::parse(locale.unwrap_or(env.locale.as_str()));
        let preferences = &mut env.locale_settings;
        preferences.hour_cycle = parsed.hour_cycle;
        preferences.first_day_of_week = parsed.first_day_of_week;
        preferences.measurement_system = parsed.measurement_system;
        preferences.temperature_unit = parsed.temperature_unit;
        if let Some(cycle) = regional
            .get("hourCycle")
            .and_then(|v| v.as_str())
            .and_then(nsh_core::platform::HourCycle::parse)
        {
            preferences.hour_cycle = cycle;
        }
        if let Some(day) = regional
            .get("firstDay")
            .and_then(|v| v.as_u64())
            .and_then(|d| u8::try_from(d).ok())
            .and_then(nsh_core::platform::Weekday::from_number)
        {
            preferences.first_day_of_week = day;
        }
    }
    if let Some(zone) = value
        .get("timeZone")
        .and_then(|v| v.as_str())
        .and_then(nsh_core::platform::TimeZone::parse)
    {
        env.locale_settings.time_zone = zone;
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
    env.lifecycle = match value.get("lifecycle").and_then(|v| v.as_str()) {
        Some("background") => Lifecycle::Background,
        Some("inactive") => Lifecycle::Inactive,
        Some(_) => Lifecycle::Active,
        None => env.lifecycle,
    };
    env.screen_color = flag("screenColor").unwrap_or(env.screen_color);
    env.notifications = flag("notifications").unwrap_or(env.notifications);
    env.audio = flag("audio").unwrap_or(env.audio);
    env.shaders = flag("shaders").unwrap_or(env.shaders);
    PAGE.with(|p| p.set(Some(env)));
    send(|app| {
        let e = &mut app.environment;
        e.locale = env.locale;
        e.locale_settings = env.locale_settings;
        e.rtl = env.rtl;
        e.apple_keyboard = env.apple_keyboard;
        e.reduce_motion = env.reduce_motion;
        e.font_scale = env.font_scale;
        let rescaled = e.pixel_ratio != env.pixel_ratio;
        e.pixel_ratio = env.pixel_ratio;
        e.safe_area = env.safe_area;
        e.keyboard_height = env.keyboard_height;
        e.lifecycle = env.lifecycle;
        e.screen_color = env.screen_color;
        e.notifications = env.notifications;
        e.audio = env.audio;
        e.shaders = env.shaders;
        app.control.set_environment(app.environment);
        // The DOM draws emoji as wide as the pixel ratio makes them.
        if rescaled && app.text.emoji_measured() {
            app.text.clear_caches();
            app.control.fonts_changed();
        }
    })
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

/// Sets up logging, panics and the runtime's data once.
fn init() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Info);
        std::panic::set_hook(Box::new(|info| {
            ffi::report_panic(&format!("nsh panicked: {info}"));
        }));
        // What this module leaves out (the syntaxes) comes from the page.
        nsh_core::runtime_data::set_loader(ffi::load_data);
    });
}

/// Hands over the runtime's data `name` that the page fetched for
/// `load_data` (`nsh_core::runtime_data`): its bytes when `ok` is 1; with 0
/// the page has no such file or it did not load. Returns the delay (ms)
/// until [`nsh_pump`] is due, or -1.
///
/// # Safety
///
/// Both ranges are memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_data(
    name: *const u8,
    name_len: usize,
    ptr: *const u8,
    len: usize,
    ok: u32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let (name, data) = unsafe { (string(name, name_len), bytes(ptr, len)) };
    nsh_core::runtime_data::deliver(&name, (ok != 0).then(|| data.to_vec()));
    pump()
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
        content_culling: false,
        network: Some(std::sync::Arc::new(net::WebNetwork)),
        websocket: Some(std::sync::Arc::new(websocket::BrowserWebSocket)),
        refuse_connections: None,
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
        host: {
            let host = nsh_engine::HostChannel::new();
            let params = HOST_PARAMS.with(|p| std::mem::take(&mut *p.borrow_mut()));
            if !params.is_empty() {
                host.set_params(params);
            }
            host
        },
        picker: None,
        speech: None,
        audio: None,
        windows: None,
    };
    // A test session's app: the test's storage, network and trace.
    #[cfg(feature = "dev")]
    TEST_MODEL.with(|m| {
        if let Some(model) = &*m.borrow() {
            model.set_up_engine(&mut config);
        }
    });
    let text = Rc::new(WebTextEngine::default());
    // The page's address, there before the app's code runs, with the page's
    // base URL, which Rust's `set_app_url` resolves against as
    // `history.replaceState` does.
    let page = PAGE_URL.with(|u| u.borrow_mut().take()).map(|url| {
        let base = BASE_URL
            .with(|b| b.borrow().clone())
            .unwrap_or_else(|| url.clone());
        serde_json::json!({ "url": url, "page": true, "quiet": true, "base": base })
    });
    let Some(mut engine) = LocalEngine::start_with(config, text.clone(), Sink, |control| {
        if let Some(payload) = page {
            if let Some(payload) = event::payload(EventKind::UrlScheme, payload) {
                control.dispatch_event(ROOT_ID, EventKind::UrlScheme, payload);
            }
        }
    }) else {
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

/// What the page calls after a gate (`nsh_part_*`, `nsh_std_*`,
/// `nsh_feature_*`, an app UI set's) ran once an app had started, as when
/// a side module loads before a chunk that needs it: the running engine
/// and its JavaScript host serve the UI sets as they are now to what is
/// mounted and imported from then on. `gate` names it (for the log only);
/// the standard modules and the shader compiler need nothing more, as
/// their calls read what the gate set. Returns the delay (ms) until
/// [`nsh_pump`] is due, or -1.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_after_gate(ptr: *const u8, len: usize) -> f64 {
    // SAFETY: guaranteed by the caller.
    let gate = unsafe { string(ptr, len) };
    let running = APP.with(|a| a.borrow().is_some());
    if !running {
        return pump();
    }
    log::debug!(target: "nsh::perf", "{gate} registered after the app started");
    let sets = ui_sets();
    APP.with(|a| {
        if let Some(app) = a.borrow_mut().as_mut() {
            app.engine.extend_ui_sets(&sets);
        }
    });
    // The JavaScript host describes the new exports to the app's realm.
    #[cfg(feature = "browser-core")]
    browser::extend_registries(&sets);
    pump()
}

/// Sets the address the app started next starts at (`UrlScheme.url()`,
/// `app_url`): the page's, when the app is the page.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_set_page_url(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let url = unsafe { string(ptr, len) };
    PAGE_URL.with(|u| *u.borrow_mut() = Some(url));
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

/// Sets the launch parameters of the next app the page starts (its
/// `host.params`, a JSON object; anything else is none): what the page
/// knows before the app runs, such as data it was served with, so the
/// app's first frame shows it without asking for it again.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_set_host_params(ptr: *const u8, len: usize) {
    // SAFETY: guaranteed by the caller.
    let json = unsafe { string(ptr, len) };
    let params = match serde_json::from_str(&json) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    HOST_PARAMS.with(|p| *p.borrow_mut() = params);
}

/// Compiles one module (`name`'s extension says TSX, TS, JSX or JS) to the
/// ES module the browser host runs (`runSource`), for the playground. Returns 1 when it
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
    let sets: Vec<nsh_core::element::description::SetDescription> = ui_sets()
        .iter()
        .flat_map(nsh_core::element::Registry::sets)
        .filter_map(nsh_core::element::description::SetDescription::of)
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
                APP.with(|a| a.borrow().as_ref().is_some_and(|r| r.animation.finishing()));
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
    APP.with(|a| {
        let mut app = a.borrow_mut();
        let Some(app) = app.as_mut() else { return };
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
        if !out.is_empty() {
            ffi::submit(&out.finish());
        }
        finish_animations(app);
    });
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

/// A display frame (`requestAnimationFrame`, `now` in ms), or one the page
/// runs at a deadline while frames stop ([`nsh_deadline`]): ticks the
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
                ffi::submit(&out.finish());
            }
            finish_animations(app);
        }
        if std::mem::take(&mut app.js_frame) {
            app.control.frame();
        }
    });
    pump()
}

/// When the native animations next have something to end that the app
/// hears of (an animation's `finished`): a time in ms on [`nsh_frame`]'s
/// clock, given the time `now` on it, or -1 for nothing (none runs, or
/// only ones that loop forever). While animation frames stop (a hidden
/// tab), the page runs an [`nsh_frame`] by then (`Player.keepDeadline`).
#[unsafe(no_mangle)]
pub extern "C" fn nsh_deadline(now: f64) -> f64 {
    let at = APP.with(|a| {
        let app = a.borrow();
        // The animation graph's clock is in seconds.
        app.as_ref()?.animation.deadline(now / 1000.0)
    });
    at.map_or(-1.0, |at| at * 1000.0)
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
    let Some(payload) = event::payload(kind, value) else {
        return pump();
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
    paste.html = text(&value, "html");
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

/// A file picked for the pick `nsh.js` is answering (`Picker.pickFiles`)
/// that is larger than the pick reads: its name, its type, its size in
/// bytes and when it was last changed (ms since the Unix epoch), without its
/// bytes. [`nsh_picked`] sends it with the others.
///
/// # Safety
///
/// The two ranges are memory from [`nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_picked_too_large(
    name: *const u8,
    name_len: usize,
    mime: *const u8,
    mime_len: usize,
    len: f64,
    last_modified: f64,
) {
    // SAFETY: guaranteed by the caller.
    let (name, mime) = unsafe { (string(name, name_len), string(mime, mime_len)) };
    // A `File.size`: a whole number of bytes (`as` saturates).
    let mut file = nsh_core::picker::PickedFile::too_large(name, mime, len.max(0.0) as u64);
    if last_modified.is_finite() && last_modified >= 0.0 {
        file.last_modified =
            Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(last_modified as u64));
    }
    PICKED.with_borrow_mut(|files| files.push(file));
}

/// Answers pick `request` with the files [`nsh_picked_file`] and
/// [`nsh_picked_too_large`] gave (none: cancelled).
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
/// pageY, x, y, changed, pointerType }] }` (`phase`: 0 start, 1 move, 2 end, 3
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
                    pointer_type: p
                        .get("pointerType")
                        .and_then(|v| v.as_str())
                        .and_then(nsh_core::PointerType::from_name)
                        .unwrap_or(nsh_core::PointerType::Touch),
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
/// Windows key), `focus` bits 1 when a text field has the focus and 2 when
/// a control that Return and Space press has it (they then fire only the
/// focus' own bindings, [`Keymap::find_at`](nsh_core::keymap::Keymap::find_at)),
/// `repeat` for an auto-repeat. Returns the binding that fires, -1 for none (the key
/// goes on), -2 for a held key's repeat (consumed, nothing fires) or
/// `-3 - id` for binding `id` passing the key through (it fires, then the
/// key goes on). JS reports a firing binding with [`nsh_key_command`].
///
/// `f64` keeps every `u32` binding ID positive in JS, including Rust
/// shortcuts (`1 << 31` and up) and overlay Escape (`u32::MAX`), while
/// leaving the negative sentinels distinct.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_key(key: u32, modifiers: u32, focus: u32, repeat: u32) -> f64 {
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
            k.find_at(
                nsh_core::ROOT_ID,
                keystroke,
                focus & 1 != 0,
                focus & 2 != 0,
                repeat != 0,
            )
        })
    });
    match found {
        KeyMatch::None => -1.0,
        KeyMatch::Held => -2.0,
        KeyMatch::Fire(id) => id as f64,
        KeyMatch::Notify(id) => -3.0 - id as f64,
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
                ffi::submit(&out.finish());
            }
        }
        app.control.scroll(id, point(px(x), px(y)), applied);
    })
}

/// The text of multiline input `id` scrolled to `y`, or its height
/// (`content`) or its viewport's changed, while a built-in bar takes the
/// place of its indicator.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_input_scroll(
    id: u32,
    y: f32,
    width: f32,
    content: f32,
    viewport: f32,
) -> f64 {
    send(|app| {
        app.control.input_scroll(
            id,
            point(px(0.0), px(y)),
            size(px(width), px(content.max(viewport))),
            size(px(width), px(viewport)),
        );
    })
}

/// Vertical scroll view `id` is pulled `distance` past its top: its pull
/// value (`pullValue`) follows.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_pull(id: u32, distance: f32) -> f64 {
    send(|app| {
        if app.animation.pulled(id, distance) {
            let mut out = Out::new();
            app.animation.outputs(&mut out);
            if !out.is_empty() {
                ffi::submit(&out.finish());
            }
        }
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
            ffi::submit(&out.finish());
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
            ffi::submit(&out.finish());
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
    send(|app| app.control.set_states(id, states as u16))
}

/// The user gave the page input with a pointer (`modality` 1: a mouse
/// button, a pen or a finger going down) or the keyboard (0: a key that
/// is not a modifier alone), before it acts: `focus-visible:` follows it.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_input_modality(modality: u32) -> f64 {
    let modality = if modality == 1 {
        nsh_core::platform::InputModality::Pointer
    } else {
        nsh_core::platform::InputModality::Keyboard
    };
    send(|app| app.control.set_input_modality(modality))
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
