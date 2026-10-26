//! Development host support: connects to the `nsh` dev server, loads every
//! pushed bundle, forwards logs to the developer's terminal and shows build
//! and runtime errors on screen.
//!
//! The dev client runs on its own thread (it reconnects with a backoff
//! when the server goes away); each of its events hops to the main thread
//! with [`crate::window::invoke`], which needs `Send` closures, so the
//! session's state lives in a thread-local map and events find it by key
//! (as the engine's batches find their surface).
//!
//! The status line and the error overlay are items the root view hosts
//! ([`Hosted`]): drawn above the whole app, modals included, with Direct2D
//! and DirectWrite, laid out against the root's size and placed again when
//! the window is resized ([`crate::surface::Surface::on_resized`]).

use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    io::Write,
    rc::{Rc, Weak},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use nsh_core::Color;
use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{App, BYTECODE_VERSION, Bundle, HotUpdate, Limits, Policy};
use rustc_hash::FxHashMap;
use windows::{
    Win32::Graphics::{
        Direct2D::{D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ROUNDED_RECT},
        DirectWrite::{
            DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT,
            DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_WEIGHT_SEMI_BOLD,
            DWRITE_LINE_METRICS, DWRITE_TEXT_METRICS, DWRITE_TRIMMING,
            DWRITE_TRIMMING_GRANULARITY_CHARACTER, DWRITE_WORD_WRAPPING_NO_WRAP,
            DWRITE_WORD_WRAPPING_WRAP, IDWriteTextFormat, IDWriteTextLayout,
        },
    },
    core::HSTRING,
};
use windows_numerics::Vector2;

use crate::{
    app::AppView,
    geom::rect,
    image::AssetBase,
    input::{Cursor, PointerKind},
    render::{DrawCx, rect_f},
    view::{Hosted, ItemPointer, NshView},
};

/// The client of the most recent session: logs go there.
static CLIENT: Mutex<std::sync::Weak<DevClient>> = Mutex::new(std::sync::Weak::new());
/// While connected, logs go to the dev server only (the developer's
/// terminal); otherwise to stderr.
static CONNECTED: AtomicBool = AtomicBool::new(false);

struct DevLogger;

impl log::Log for DevLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target().starts_with("nsh")
            || metadata.target() == "js"
            || metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        let client = CLIENT.lock().ok().and_then(|c| c.upgrade());
        match client {
            Some(client) if CONNECTED.load(Ordering::Relaxed) => {
                client.log(record.level().into(), record.target(), &message)
            }
            _ => {
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "{:>5} {} {message}",
                    record.level(),
                    record.target()
                );
            }
        }
    }

    fn flush(&self) {}
}

/// Installs a logger that prints to stderr and forwards every line to the
/// dev server once connected. Call first thing in a development host.
pub fn init_logging() {
    static LOGGER: DevLogger = DevLogger;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

thread_local! {
    /// The dev sessions of this (main) thread, by key.
    static SESSIONS: RefCell<FxHashMap<u64, Rc<RefCell<DevUi>>>> = RefCell::default();
}

static NEXT_KEY: AtomicU64 = AtomicU64::new(1);

/// A connection to a dev server, loading its bundles into one view.
/// Dropping it (with its [`AppView`]) stops the client.
pub(crate) struct DevSession {
    key: u64,
    /// Keeps the client (and its thread) alive.
    _client: Arc<DevClient>,
}

impl Drop for DevSession {
    fn drop(&mut self) {
        let key = self.key;
        // Dropped during thread teardown: the map may be gone already.
        let ui = SESSIONS
            .try_with(|s| s.borrow_mut().remove(&key))
            .ok()
            .flatten();
        drop(ui);
    }
}

/// What a session shows and runs.
struct DevUi {
    /// Its key in [`SESSIONS`].
    key: u64,
    view: Weak<AppView>,
    /// The root view the overlays are hosted on.
    root: NshView,
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle with its server run and number, for reloads.
    latest: Option<(u64, u64, Bundle)>,
    status: Option<Rc<StatusLine>>,
    error: Option<Rc<ErrorOverlay>>,
}

/// What the status line says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status<'a> {
    /// Before the first connection, to the server at the URL.
    Connecting(&'a str),
    /// The server went away; the client keeps retrying.
    Reconnecting,
    /// The server is rebuilding the app.
    Building,
}

impl Status<'_> {
    fn text(self) -> String {
        match self {
            Status::Connecting(url) => format!("Connecting to {url}…"),
            Status::Reconnecting => "Dev server disconnected — reconnecting…".to_owned(),
            Status::Building => "Building…".to_owned(),
        }
    }
}

/// Connects `view` to the dev server at `url` (`ws://host:port/ws`).
pub(crate) fn start(view: &Rc<AppView>, url: String) {
    if let Some(base) = asset_base(&url) {
        view.set_asset_base(Some(AssetBase::Http(base)));
    }
    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
    let surface = view.surface().clone();
    let ui = Rc::new(RefCell::new(DevUi {
        key,
        view: Rc::downgrade(view),
        root: surface.root.clone(),
        running: None,
        latest: None,
        status: None,
        error: None,
    }));
    SESSIONS.with(|s| s.borrow_mut().insert(key, ui.clone()));
    show_status(&ui, Status::Connecting(&url));
    install_reload_key(&surface, key);

    surface.set_error_handler(Box::new(move |message| {
        if let Some(ui) = session(key) {
            show_error(&ui, "Uncaught error", message, false);
        }
    }));
    surface.set_hot_update_failed(move || {
        if let Some(ui) = session(key) {
            reload(&ui);
        }
    });
    surface
        .on_resized
        .borrow_mut()
        .push(Box::new(move |width, height| {
            if let Some(ui) = session(key) {
                place(&ui.borrow(), (width, height));
            }
        }));

    let host = HostInfo {
        device: device_name(std::env::var("COMPUTERNAME").ok().as_deref()),
        platform: HostPlatform::Windows,
        bytecode_version: BYTECODE_VERSION.to_owned(),
        ui_sets: crate::app::ui_sets()
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .filter_map(|set| set.specifier().map(str::to_owned))
            .collect(),
        tests: true,
    };
    // A test session (`nsh test --target windows`): the surface keeps the
    // model the agent's steps see, from the first bundle on (posted
    // messages keep their order, so it comes before the bundle).
    let key_of_surface = surface.key();
    let tester = nsh_testing::agent::Tester::new(move |model| {
        crate::window::invoke(move || {
            if let Some(surface) = crate::surface::Surface::by_key(key_of_surface) {
                surface.set_test_model(Some(model));
            }
        });
        Box::new(crate::agent::WindowsNative::new(key_of_surface))
    });
    let tests = tester.clone();
    let started = DevClient::start(url, host, move |event| {
        // Taken off the main thread: a step waits for what it does there.
        let Some(event) = tests.event(event) else {
            return;
        };
        match event {
            DevEvent::Connected => CONNECTED.store(true, Ordering::Relaxed),
            DevEvent::Disconnected => CONNECTED.store(false, Ordering::Relaxed),
            _ => {}
        }
        // Posted messages arrive in the order they were posted, so events
        // keep theirs.
        crate::window::invoke(move || {
            if let Some(ui) = session(key) {
                handle(&ui, event);
            }
        });
    });
    match started {
        Ok(client) => {
            let client = Arc::new(client);
            tester.set_client(&client);
            *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(&client);
            *view.dev.borrow_mut() = Some(DevSession {
                key,
                _client: client,
            });
        }
        Err(err) => {
            log::error!("cannot start the dev client: {err}");
            hide_status(&ui);
            show_error(&ui, "Cannot connect", &err.to_string(), true);
        }
    }
}

fn session(key: u64) -> Option<Rc<RefCell<DevUi>>> {
    SESSIONS.with(|s| s.borrow().get(&key).cloned())
}

/// Ctrl+R (as on Linux, Cmd+R on macOS) and F5 (Windows' own) load the
/// latest build again, wherever the window's focus is.
fn install_reload_key(surface: &crate::surface::Surface, key: u64) {
    const VK_R: u16 = 0x52;
    const VK_F5: u16 = 0x74;
    surface.shortcuts.borrow_mut().push(Box::new(move |event| {
        let m = event.modifiers;
        let reload = match event.vk {
            VK_R => m.ctrl && !m.alt && !m.shift && !m.meta,
            VK_F5 => !m.ctrl && !m.alt && !m.shift && !m.meta,
            _ => false,
        };
        let Some(ui) = session(key).filter(|_| reload) else {
            return false;
        };
        if !event.repeat {
            reload_latest(&ui);
        }
        true
    }));
}

/// Loads the latest build from scratch (Ctrl+R, F5).
fn reload_latest(ui: &Rc<RefCell<DevUi>>) {
    let (view, bundle) = {
        let mut ui = ui.borrow_mut();
        let Some((session, version, bundle)) = ui.latest.clone() else {
            return;
        };
        ui.running = Some((session, version));
        (ui.view.upgrade(), bundle)
    };
    if let Some(view) = view {
        log::info!("reloading");
        hide_error(ui);
        view.load(App::Js(bundle));
    }
}

/// `ws://host:port/ws` → `http://host:port/assets/`, where the dev server
/// serves the app's assets.
fn asset_base(url: &str) -> Option<String> {
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("ws://") {
        ("http", rest)
    } else {
        ("https", url.strip_prefix("wss://")?)
    };
    let host = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("{scheme}://{host}/assets/"))
}

/// The name the developer's terminal shows for this machine.
fn device_name(computer: Option<&str>) -> String {
    match computer.map(str::trim) {
        Some(name) if !name.is_empty() => format!("Windows ({name})"),
        _ => "Windows".to_owned(),
    }
}

fn handle(ui: &Rc<RefCell<DevUi>>, event: DevEvent) {
    match event {
        DevEvent::Connected => hide_status(ui),
        DevEvent::Disconnected => show_status(ui, Status::Reconnecting),
        // The client's thread hands them to the test agent.
        DevEvent::Testing
        | DevEvent::Step { .. }
        | DevEvent::TestSetup { .. }
        | DevEvent::Fetch { .. } => {}
        DevEvent::Root => {
            hide_status(ui);
            let Some(root) = crate::app::root() else {
                return show_error(
                    ui,
                    "This host cannot run the app",
                    "The app is of Rust only, and this host was not built with its root.",
                    true,
                );
            };
            let view = {
                let mut ui = ui.borrow_mut();
                ui.latest = None;
                ui.running = None;
                ui.view.upgrade()
            };
            let Some(view) = view else { return };
            hide_error(ui);
            view.load(App::Rust(root));
        }
        DevEvent::Building => show_status(ui, Status::Building),
        DevEvent::BuildFailed(message) => {
            hide_status(ui);
            show_error(ui, "Build failed", &message, false)
        }
        DevEvent::CannotRun { message, .. } => {
            hide_status(ui);
            show_error(ui, "This host cannot run the app", &message, true)
        }
        DevEvent::Bundle {
            session,
            version,
            format,
            bytes,
            source_map,
            capabilities,
            app_id,
            limits,
        } => {
            hide_status(ui);
            let mut bundle = match format {
                // SAFETY: compiled for this runtime's bytecode version (the
                // handshake) by the dev server the developer connected to,
                // a trusted source (docs/dev/sandbox.md).
                BundleFormat::Bytecode => {
                    unsafe { Bundle::bytecode(bytes) }.with_policy(Policy::development())
                }
                BundleFormat::Source => match String::from_utf8(bytes) {
                    Ok(code) => Bundle::source(code).with_policy(Policy::development()),
                    Err(_) => {
                        return show_error(
                            ui,
                            "Invalid bundle",
                            "the dev server sent non-UTF-8 source",
                            true,
                        );
                    }
                },
            };
            if let Some(map) = source_map {
                bundle = bundle.with_source_map(map);
            }
            bundle = match bundle
                .with_app_id(app_id.as_deref())
                .with_capabilities_json(capabilities.as_deref())
            {
                Ok(bundle) => bundle,
                Err(err) => return show_error(ui, "Invalid capabilities", &err, true),
            };
            let limits = match Limits::development(limits.as_deref()) {
                Ok(limits) => limits,
                Err(err) => return show_error(ui, "Invalid limits", &err, true),
            };
            let (view, running) = {
                let mut ui = ui.borrow_mut();
                ui.latest = Some((session, version, bundle.clone()));
                (ui.view.upgrade(), ui.running.replace((session, version)))
            };
            // Already there through a hot update.
            if running == Some((session, version)) {
                return;
            }
            let Some(view) = view else { return };
            log::info!("loading build {version}");
            hide_error(ui);
            view.set_limits(limits);
            view.load(App::Js(bundle));
        }
        DevEvent::Patch {
            session,
            version,
            base,
            code,
            source_map,
        } => {
            let view = {
                let ui = ui.borrow();
                if ui.running != Some((session, base)) {
                    // Not for the running build: its bundle follows.
                    return;
                }
                ui.view.upgrade()
            };
            let Some(view) = view else { return };
            let update = HotUpdate {
                name: format!("hot-{version}.js"),
                code,
                source_map: source_map.map(Into::into),
            };
            let mut applied = false;
            view.surface().control(|c| {
                c.hot_update(update);
                applied = true;
            });
            if applied {
                log::info!("updating to build {version}");
                ui.borrow_mut().running = Some((session, version));
                hide_status(ui);
                hide_error(ui);
            }
        }
    }
}

/// A hot update could not be applied in place: loads its build from
/// scratch, or, while that bundle is still on its way, lets it load when it
/// comes.
fn reload(ui: &Rc<RefCell<DevUi>>) {
    let (view, bundle) = {
        let mut ui = ui.borrow_mut();
        let target = ui.running.take();
        let bundle = match &ui.latest {
            Some((session, version, bundle)) if Some((*session, *version)) == target => {
                bundle.clone()
            }
            _ => return,
        };
        ui.running = target;
        (ui.view.upgrade(), bundle)
    };
    if let Some(view) = view {
        log::info!("reloading after an update that could not be applied in place");
        view.load(App::Js(bundle));
    }
}

/// Places the overlays for a root of `size` (points).
fn place(ui: &DevUi, size: (f32, f32)) {
    if let Some(status) = &ui.status {
        let r = status.layout(size.0);
        ui.root.set_native(
            &(status.clone() as Rc<dyn Hosted>),
            rect(r.0, r.1, r.2, r.3),
        );
    }
    if let Some(error) = &ui.error {
        ui.root.set_native(
            &(error.clone() as Rc<dyn Hosted>),
            rect(0.0, 0.0, size.0, size.1),
        );
    }
}

fn root_size(ui: &DevUi) -> (f32, f32) {
    let s = ui.root.state();
    (s.frame.size.width.0, s.frame.size.height.0)
}

fn show_status(ui: &RefCell<DevUi>, status: Status<'_>) {
    let text = status.text();
    let mut ui = ui.borrow_mut();
    match &ui.status {
        Some(line) => line.set_text(text),
        None => ui.status = Some(Rc::new(StatusLine::new(text))),
    }
    let size = root_size(&ui);
    place(&ui, size);
}

fn hide_status(ui: &RefCell<DevUi>) {
    let mut ui = ui.borrow_mut();
    if let Some(line) = ui.status.take() {
        ui.root.remove_native(&(line as Rc<dyn Hosted>));
    }
}

/// Shows `title` and `message` over the whole app; a click dismisses it.
/// `prose` wraps the message to the view; otherwise its lines are kept
/// (code frames, stack traces) and cut at the right edge.
fn show_error(ui: &Rc<RefCell<DevUi>>, title: &str, message: &str, prose: bool) {
    hide_error(ui);
    let mut state = ui.borrow_mut();
    state.error = Some(Rc::new(ErrorOverlay {
        key: state.key,
        title: title.to_owned(),
        message: clean_message(message).into_owned(),
        prose,
        copied: Cell::new(false),
        layout: RefCell::new(None),
    }));
    let size = root_size(&state);
    place(&state, size);
}

fn hide_error(ui: &RefCell<DevUi>) {
    let mut ui = ui.borrow_mut();
    if let Some(error) = ui.error.take() {
        ui.root.remove_native(&(error as Rc<dyn Hosted>));
    }
}

// ---------------------------------------------------------------------------
// Drawing

const WHITE: Color = Color::rgba(255, 255, 255, 255);
/// The status line's pill.
const STATUS_BACKGROUND: Color = Color::rgba(26, 26, 26, 217);
/// The error overlay's panel.
const ERROR_BACKGROUND: Color = Color::rgba(30, 31, 34, 250);
/// The error's title: it alone says it is an error.
const ERROR_TITLE: Color = Color::rgba(255, 107, 107, 255);
/// The Copy button's fill.
const COPY_BACKGROUND: Color = Color::rgba(255, 255, 255, 31);
const HINT: Color = Color::rgba(255, 255, 255, 179);

/// The status line's padding (points): sideways, then up and down.
const STATUS_PAD: (f32, f32) = (14.0, 6.0);
/// The status line's distance from the top and the sides.
const STATUS_MARGIN: (f32, f32) = (16.0, 10.0);

/// The error overlay's margins (points).
const ERROR_TOP: f32 = 20.0;
const ERROR_BOTTOM: f32 = 24.0;
const ERROR_SIDE: f32 = 16.0;
const ERROR_GAP: f32 = 12.0;
/// The Copy button's size and its distance from the top and the right.
const COPY_SIZE: (f32, f32) = (76.0, 28.0);
const COPY_MARGIN: (f32, f32) = (14.0, 24.0);
/// Longest message shown (UTF-16 units are counted by DirectWrite; this
/// caps the characters handed to it): a runaway log stays cheap.
const MAX_MESSAGE_CHARS: usize = 20_000;

/// A DirectWrite text format: `family` at `size` points.
fn text_format(family: &str, size: f32, weight: DWRITE_FONT_WEIGHT) -> Option<IDWriteTextFormat> {
    // SAFETY: plain factory call with valid strings.
    unsafe {
        crate::gfx::dwrite()
            .CreateTextFormat(
                &HSTRING::from(family),
                None,
                weight,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                &HSTRING::from("en-us"),
            )
            .ok()
    }
}

/// Cuts lines that overflow `format`'s layouts with an ellipsis.
fn trim_with_ellipsis(format: &IDWriteTextFormat) {
    let trimming = DWRITE_TRIMMING {
        granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
        delimiter: 0,
        delimiterCount: 0,
    };
    // SAFETY: plain DirectWrite calls on live objects.
    unsafe {
        if let Ok(sign) = crate::gfx::dwrite().CreateEllipsisTrimmingSign(format) {
            let _ = format.SetTrimming(&trimming, &sign);
        }
    }
}

/// `text` laid out with `format` in a box of `width` × `height`.
fn layout(
    text: &str,
    format: &IDWriteTextFormat,
    width: f32,
    height: f32,
) -> Option<IDWriteTextLayout> {
    let wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: plain factory call; the string outlives the call.
    unsafe {
        crate::gfx::dwrite()
            .CreateTextLayout(&wide, format, width.max(1.0), height.max(1.0))
            .ok()
    }
}

/// The size `layout`'s text takes.
fn measure(layout: &IDWriteTextLayout) -> (f32, f32) {
    let mut m = DWRITE_TEXT_METRICS::default();
    // SAFETY: a valid out pointer.
    match unsafe { layout.GetMetrics(&mut m) } {
        Ok(()) => (m.widthIncludingTrailingWhitespace, m.height),
        Err(_) => (0.0, 0.0),
    }
}

/// The heights of `layout`'s lines, with their lengths (UTF-16 units).
fn line_metrics(layout: &IDWriteTextLayout) -> Vec<DWRITE_LINE_METRICS> {
    let mut count = 0u32;
    // SAFETY: a valid out pointer; the first call only counts (and fails
    // with "insufficient buffer").
    let _ = unsafe { layout.GetLineMetrics(None, &mut count) };
    let mut lines = vec![DWRITE_LINE_METRICS::default(); count as usize];
    // SAFETY: a buffer of the size just reported.
    if unsafe { layout.GetLineMetrics(Some(&mut lines), &mut count) }.is_err() {
        lines.clear();
    }
    lines
}

fn draw_layout(cx: &DrawCx<'_>, layout: &IDWriteTextLayout, x: f32, y: f32, color: Color) {
    // SAFETY: a COM call between BeginDraw and EndDraw.
    unsafe {
        cx.dc.DrawTextLayout(
            Vector2 { X: x, Y: y },
            layout,
            cx.solid(color),
            D2D1_DRAW_TEXT_OPTIONS_NONE,
        );
    }
}

/// The pill at the top of the window that says what the dev client does.
/// Information only: the app below keeps its input.
struct StatusLine {
    text: RefCell<String>,
    /// The text's layout, for the width it was made for.
    layout: RefCell<Option<(f32, IDWriteTextLayout)>>,
}

impl StatusLine {
    fn new(text: String) -> Self {
        StatusLine {
            text: RefCell::new(text),
            layout: RefCell::new(None),
        }
    }

    fn set_text(&self, text: String) {
        if *self.text.borrow() != text {
            *self.text.borrow_mut() = text;
            self.layout.borrow_mut().take();
        }
    }

    /// Lays the text out for a root `width` points wide: the line's frame
    /// (x, y, width, height), centered at the top.
    fn layout(&self, width: f32) -> (f32, f32, f32, f32) {
        let max = (width - 2.0 * (STATUS_MARGIN.0 + STATUS_PAD.0)).max(1.0);
        let mut cached = self.layout.borrow_mut();
        if cached.as_ref().is_none_or(|(w, _)| *w != max) {
            *cached = text_format("Segoe UI", 12.0, DWRITE_FONT_WEIGHT_SEMI_BOLD)
                .and_then(|format| {
                    // SAFETY: plain DirectWrite call on a live format.
                    unsafe {
                        let _ = format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
                    }
                    trim_with_ellipsis(&format);
                    layout(&self.text.borrow(), &format, max, 100.0)
                })
                .map(|l| (max, l));
        }
        let (tw, th) = cached.as_ref().map_or((0.0, 16.0), |(_, l)| measure(l));
        let (w, h) = (tw.min(max) + 2.0 * STATUS_PAD.0, th + 2.0 * STATUS_PAD.1);
        (((width - w) / 2.0).max(0.0), STATUS_MARGIN.1, w, h)
    }
}

impl Hosted for StatusLine {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let pill = D2D1_ROUNDED_RECT {
            rect: rect_f(0.0, 0.0, size.0, size.1),
            radiusX: size.1 / 2.0,
            radiusY: size.1 / 2.0,
        };
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc
                .FillRoundedRectangle(&pill, cx.solid(STATUS_BACKGROUND))
        };
        if let Some((_, layout)) = &*self.layout.borrow() {
            draw_layout(cx, layout, STATUS_PAD.0, STATUS_PAD.1, WHITE);
        }
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
}

/// The error overlay's layouts for one size.
struct ErrorLayout {
    size: (f32, f32),
    title: Option<IDWriteTextLayout>,
    title_height: f32,
    message: Option<IDWriteTextLayout>,
    hint: Option<IDWriteTextLayout>,
    hint_height: f32,
    /// The Copy button's labels: before and after a click.
    copy: [Option<IDWriteTextLayout>; 2],
}

/// The Copy button's frame (x, y, width, height) in an overlay of `size`.
fn copy_rect(size: (f32, f32)) -> (f32, f32, f32, f32) {
    (
        size.0 - COPY_MARGIN.1 - COPY_SIZE.0,
        COPY_MARGIN.0,
        COPY_SIZE.0,
        COPY_SIZE.1,
    )
}

/// A panel over the whole app with an error's title and message; a click
/// dismisses it, one on its Copy button copies the error.
struct ErrorOverlay {
    /// The session it belongs to (read by `pointer`, which goes unused
    /// until the input module routes pointers to hosted items).
    #[allow(dead_code)]
    key: u64,
    title: String,
    message: String,
    prose: bool,
    /// Whether the Copy button was clicked (it says "Copied" then).
    copied: Cell<bool>,
    layout: RefCell<Option<ErrorLayout>>,
}

impl ErrorOverlay {
    fn lay_out(&self, size: (f32, f32)) -> ErrorLayout {
        let width = (size.0 - 2.0 * ERROR_SIDE).max(1.0);
        // Clear of the Copy button.
        let title_width = (copy_rect(size).0 - ERROR_SIDE - ERROR_GAP).max(1.0);
        let title = text_format("Segoe UI", 16.0, DWRITE_FONT_WEIGHT_BOLD)
            .and_then(|f| layout(&self.title, &f, title_width, size.1));
        let copy = ["Copy", "Copied"].map(|label| {
            text_format("Segoe UI", 13.0, DWRITE_FONT_WEIGHT_SEMI_BOLD)
                .and_then(|f| layout(label, &f, COPY_SIZE.0, COPY_SIZE.1))
        });
        let title_height = title.as_ref().map_or(0.0, |l| measure(l).1);
        let hint = text_format("Segoe UI", 11.0, DWRITE_FONT_WEIGHT_NORMAL)
            .and_then(|f| layout("Click to dismiss · Ctrl+R to reload", &f, width, size.1));
        let hint_height = hint.as_ref().map_or(0.0, |l| measure(l).1);
        let room = (size.1
            - ERROR_TOP
            - title_height
            - ERROR_GAP
            - ERROR_GAP
            - hint_height
            - ERROR_BOTTOM)
            .max(0.0);
        let message = text_format("Consolas", 12.0, DWRITE_FONT_WEIGHT_NORMAL).and_then(|f| {
            // SAFETY: plain DirectWrite call on a live format.
            unsafe {
                let _ = f.SetWordWrapping(if self.prose {
                    DWRITE_WORD_WRAPPING_WRAP
                } else {
                    DWRITE_WORD_WRAPPING_NO_WRAP
                });
            }
            if !self.prose {
                trim_with_ellipsis(&f);
            }
            // Measured unbounded: trimming gives the lines below a layout's
            // height no height at all.
            let full = layout(&self.message, &f, width, f32::MAX)?;
            // What does not fit is cut at a line, and says how much is left.
            let heights: Vec<(f32, u32)> = line_metrics(&full)
                .iter()
                .map(|l| (l.height, l.length))
                .collect();
            let Some(fit) = fitting_lines(&heights, room) else {
                return Some(full);
            };
            // The marker line may be taller than the line it was measured
            // as (a fallback font for the ellipsis): drop lines until the
            // result fits.
            let mut cut = None;
            for n in (0..=fit).rev() {
                let keep = heights[..n].iter().map(|l| l.1 as usize).sum();
                let candidate = layout(&truncate_at(&self.message, keep), &f, width, f32::MAX)?;
                let fits = measure(&candidate).1 <= room + 0.5;
                cut = Some(candidate);
                if fits {
                    break;
                }
            }
            cut
        });
        ErrorLayout {
            size,
            title,
            title_height,
            message,
            hint,
            hint_height,
            copy,
        }
    }
}

impl Hosted for ErrorOverlay {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let mut cached = self.layout.borrow_mut();
        if cached.as_ref().is_none_or(|l| l.size != size) {
            *cached = Some(self.lay_out(size));
        }
        let Some(l) = &*cached else { return };
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc.FillRectangle(
                &rect_f(0.0, 0.0, size.0, size.1),
                cx.solid(ERROR_BACKGROUND),
            )
        };
        let (bx, by, bw, bh) = copy_rect(size);
        let button = D2D1_ROUNDED_RECT {
            rect: rect_f(bx, by, bw, bh),
            radiusX: 6.0,
            radiusY: 6.0,
        };
        // SAFETY: a COM call between BeginDraw and EndDraw.
        unsafe {
            cx.dc
                .FillRoundedRectangle(&button, cx.solid(COPY_BACKGROUND))
        };
        if let Some(label) = &l.copy[usize::from(self.copied.get())] {
            let (w, h) = measure(label);
            draw_layout(cx, label, bx + (bw - w) / 2.0, by + (bh - h) / 2.0, WHITE);
        }
        let mut y = ERROR_TOP;
        if let Some(title) = &l.title {
            draw_layout(cx, title, ERROR_SIDE, y, ERROR_TITLE);
        }
        y += l.title_height + ERROR_GAP;
        let bottom = size.1 - ERROR_BOTTOM - l.hint_height - ERROR_GAP;
        if let Some(message) = &l.message {
            cx.push_clip_rect(
                ERROR_SIDE,
                y,
                size.0 - 2.0 * ERROR_SIDE,
                (bottom - y).max(0.0),
            );
            draw_layout(cx, message, ERROR_SIDE, y, WHITE);
            cx.pop();
        }
        if let Some(hint) = &l.hint {
            draw_layout(
                cx,
                hint,
                ERROR_SIDE,
                size.1 - ERROR_BOTTOM - l.hint_height,
                HINT,
            );
        }
    }

    fn pointer(&self, event: &ItemPointer) -> bool {
        if event.kind == PointerKind::Up {
            // Not while input still walks the root's items.
            let key = self.key;
            let size = self.layout.borrow().as_ref().map(|l| l.size);
            if let Some(size) = size {
                let (x, y, w, h) = copy_rect(size);
                if (x..=x + w).contains(&event.x) && (y..=y + h).contains(&event.y) {
                    let error = format!("{}\n\n{}", self.title, self.message);
                    if !crate::system::set_clipboard_text(&error) {
                        log::debug!("windows: cannot set the clipboard");
                    }
                    self.copied.set(true);
                    // Drawn again with its new label.
                    crate::window::invoke(move || {
                        if let Some(ui) = session(key) {
                            let ui = ui.borrow();
                            place(&ui, root_size(&ui));
                        }
                    });
                    return true;
                }
            }
            crate::window::invoke(move || {
                if let Some(ui) = session(key) {
                    hide_error(&ui);
                }
            });
        }
        true
    }

    fn cursor(&self, _x: f32, _y: f32) -> Option<Cursor> {
        Some(Cursor::Arrow)
    }
}

// ---------------------------------------------------------------------------
// Text helpers (pure, tested)

/// The message as the overlay shows it: terminal color codes removed
/// (build errors may carry them), Windows line ends made plain and the
/// length capped.
fn clean_message(message: &str) -> Cow<'_, str> {
    let needs = message.contains('\u{1b}')
        || message.contains('\r')
        || message.chars().nth(MAX_MESSAGE_CHARS).is_some();
    if !needs {
        return Cow::Borrowed(message);
    }
    let mut out = String::with_capacity(message.len().min(MAX_MESSAGE_CHARS * 4));
    let mut chars = message.chars().peekable();
    let mut count = 0;
    while let Some(c) = chars.next() {
        match c {
            // CSI sequences: ESC [ parameters final-byte.
            '\u{1b}' => {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
            }
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                    count += 1;
                }
            }
            c => {
                if count == MAX_MESSAGE_CHARS {
                    out.push('…');
                    break;
                }
                out.push(c);
                count += 1;
            }
        }
    }
    Cow::Owned(out)
}

/// When the laid out lines (`(height, length in UTF-16 units)`) do not fit
/// in `room` points, how many of them to keep so that they and one more
/// line (saying what was cut) do; `None` when all fit.
fn fitting_lines(lines: &[(f32, u32)], room: f32) -> Option<usize> {
    let total: f32 = lines.iter().map(|l| l.0).sum();
    if total <= room {
        return None;
    }
    let mut used = lines.first().map_or(0.0, |l| l.0);
    let mut keep = 0;
    for (height, _) in lines {
        if used + height > room {
            break;
        }
        used += height;
        keep += 1;
    }
    Some(keep)
}

/// The first `keep` UTF-16 units of `text` (whole characters), then a line
/// saying how many lines of the text were left out.
fn truncate_at(text: &str, keep: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (i, c) in text.char_indices() {
        if units + c.len_utf16() > keep {
            break;
        }
        units += c.len_utf16();
        end = i + c.len_utf8();
    }
    let (head, rest) = text.split_at(end);
    let head = head.trim_end_matches(['\n', ' ']);
    let rest = rest.trim_start_matches('\n');
    if rest.is_empty() {
        return head.to_owned();
    }
    let more = rest.lines().count();
    let unit = if more == 1 { "line" } else { "lines" };
    if head.is_empty() {
        format!("… {more} more {unit}")
    } else {
        format!("{head}\n… {more} more {unit}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_base_from_ws_url() {
        assert_eq!(
            asset_base("ws://127.0.0.1:8790/ws").as_deref(),
            Some("http://127.0.0.1:8790/assets/")
        );
        assert_eq!(
            asset_base("wss://dev.example.com/ws").as_deref(),
            Some("https://dev.example.com/assets/")
        );
        assert_eq!(asset_base("http://x/ws"), None);
        assert_eq!(asset_base("ws:///ws"), None);
    }

    #[test]
    fn status_texts() {
        assert_eq!(
            Status::Connecting("ws://127.0.0.1:8790/ws").text(),
            "Connecting to ws://127.0.0.1:8790/ws…"
        );
        assert_eq!(
            Status::Reconnecting.text(),
            "Dev server disconnected — reconnecting…"
        );
        assert_eq!(Status::Building.text(), "Building…");
    }

    #[test]
    fn device_names() {
        assert_eq!(device_name(Some("DESKTOP-42")), "Windows (DESKTOP-42)");
        assert_eq!(device_name(Some("  ")), "Windows");
        assert_eq!(device_name(None), "Windows");
    }

    #[test]
    fn clean_message_strips_colors_and_crlf() {
        assert!(matches!(clean_message("plain\nlines"), Cow::Borrowed(_)));
        assert_eq!(
            clean_message("\u{1b}[31merror\u{1b}[0m: x\r\n  at y\rz"),
            "error: x\n  at y\nz"
        );
    }

    #[test]
    fn clean_message_caps_length() {
        let long = "a".repeat(MAX_MESSAGE_CHARS + 10);
        let cleaned = clean_message(&long);
        assert_eq!(cleaned.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert!(cleaned.ends_with('…'));
    }

    #[test]
    fn fitting_lines_keeps_room_for_the_marker() {
        let lines = [(10.0, 5), (10.0, 6), (10.0, 7), (10.0, 8)];
        assert_eq!(fitting_lines(&lines, 40.0), None);
        // 35 points: the marker and two lines.
        assert_eq!(fitting_lines(&lines, 35.0), Some(2));
        assert_eq!(fitting_lines(&lines, 5.0), Some(0));
        assert_eq!(fitting_lines(&[], 0.0), None);
    }

    #[test]
    fn truncate_at_counts_what_is_left() {
        let text = "one\ntwo\nthree\nfour";
        assert_eq!(truncate_at(text, 4), "one\n… 3 more lines");
        assert_eq!(truncate_at(text, 8), "one\ntwo\n… 2 more lines");
        assert_eq!(truncate_at(text, 14), "one\ntwo\nthree\n… 1 more line");
        assert_eq!(truncate_at(text, 100), text);
        assert_eq!(truncate_at(text, 0), "… 4 more lines");
    }

    #[test]
    fn long_messages_are_cut_to_fit() {
        let message = (1..=40)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let overlay = ErrorOverlay {
            key: 0,
            title: "Build failed".to_owned(),
            message,
            prose: false,
            copied: Cell::new(false),
            layout: RefCell::new(None),
        };
        let l = overlay.lay_out((320.0, 200.0));
        let message = l.message.expect("a layout");
        let lines = line_metrics(&message);
        let room =
            200.0 - ERROR_TOP - l.title_height - 2.0 * ERROR_GAP - l.hint_height - ERROR_BOTTOM;
        assert!(
            lines.len() > 1 && lines.len() < 40,
            "{} lines in {room} points",
            lines.len()
        );
        assert!(measure(&message).1 <= room + 0.5);
    }

    #[test]
    fn truncate_at_keeps_whole_characters() {
        // "é" is one UTF-16 unit, the emoji two.
        // The cut line counts as left out.
        assert_eq!(truncate_at("é😀x\ny", 2), "é\n… 2 more lines");
        assert_eq!(truncate_at("é😀x\ny", 3), "é😀\n… 2 more lines");
    }
}
