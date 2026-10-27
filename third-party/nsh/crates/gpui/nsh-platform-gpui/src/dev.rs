//! Development host support: connects to the `nsh` dev server, loads every
//! pushed bundle, forwards logs to the developer's terminal and shows build
//! and runtime errors on screen.
//!
//! The dev client runs on its own thread (it reconnects with a backoff
//! when the server goes away). Its events, the surface's runtime errors and
//! failed hot updates and the reload key all go into one channel, which a
//! foreground task of the view drains in order: handling them loads apps
//! and redraws the view, which needs the GPUI app, not available where
//! they come from. The session's state lives in the view
//! ([`AppView::dev`]); the status line and the error overlay are GPUI
//! elements over the surface ([`wrap`]), drawn above the whole app,
//! modals included.

use std::{
    borrow::Cow,
    cell::RefCell,
    io::Write,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use futures_channel::mpsc::{UnboundedSender, unbounded};
use gpui::{
    AnyElement, App as GpuiApp, Context, FontWeight, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, div, px, rgba,
};
use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{
    App, AppError, AppErrorKind, BYTECODE_VERSION, Bundle, HotUpdate, Limits, Policy,
};

use crate::{app::AppView, image::AssetBase, input::KeyEvent};

/// The client of the most recent session: logs go there.
static CLIENT: Mutex<std::sync::Weak<DevClient>> = Mutex::new(std::sync::Weak::new());
/// While connected, logs go to the dev server only (the developer's
/// terminal); otherwise to stderr.
static CONNECTED: AtomicBool = AtomicBool::new(false);

/// Messages longer than this (in characters) are cut: GPUI lays out the
/// whole text of the overlay every frame it shows.
const MAX_MESSAGE_CHARS: usize = 20_000;
/// How long "Reloaded" / "Updated" stay up, in milliseconds.
const DONE_MS: u64 = 1200;

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

/// What the session's task handles, in the order it was sent.
enum Msg {
    /// From the dev client.
    Event(DevEvent),
    /// An error of the app.
    RuntimeError(AppError),
    /// The engine could not apply a hot update in place.
    HotUpdateFailed,
    /// The reload key.
    Reload,
    /// The status line shown as number `.0` is done.
    HideStatus(u64),
    /// A test session's model of the app, for the surface to keep from the
    /// first bundle on (it comes before it).
    TestModel(Arc<nsh_testing::agent::Model>),
}

/// Numbers the sessions: a replaced session's task stops.
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// A connection to a dev server, loading its bundles into one view, and
/// what it shows over the app. Dropping it (with its [`AppView`], or when
/// the view connects again) stops the client.
pub(crate) struct DevSession {
    /// Which session it is ([`NEXT_SESSION`]).
    id: u64,
    /// Keeps the client (and its thread) alive.
    _client: Option<Arc<DevClient>>,
    tx: UnboundedSender<Msg>,
    /// Where the reload key sends (the current session's channel): the
    /// key is the view's shortcut once, whatever session it reaches.
    reloads: Rc<RefCell<UnboundedSender<Msg>>>,
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle with its server run and number, for reloads.
    latest: Option<(u64, u64, Bundle)>,
    /// The status line and its number (each status shown gets the next).
    status: Option<(String, u64)>,
    shown: u64,
    error: Option<DevError>,
}

/// The error overlay's content.
struct DevError {
    title: String,
    message: String,
    /// Wrapped to the view; otherwise its lines are kept (code frames,
    /// stack traces) and it scrolls sideways.
    prose: bool,
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
    /// A build was loaded from scratch (shown for a moment).
    Reloaded,
    /// A build was applied in place (shown for a moment).
    Updated,
}

impl Status<'_> {
    fn text(self) -> String {
        match self {
            Status::Connecting(url) => format!("Connecting to {url}…"),
            Status::Reconnecting => "Dev server disconnected — reconnecting…".to_owned(),
            Status::Building => "Building…".to_owned(),
            Status::Reloaded => "Reloaded".to_owned(),
            Status::Updated => "Updated".to_owned(),
        }
    }

    /// Goes away by itself.
    fn transient(self) -> bool {
        matches!(self, Status::Reloaded | Status::Updated)
    }
}

impl DevSession {
    fn show_status(&mut self, status: Status<'_>) {
        self.shown += 1;
        self.status = Some((status.text(), self.shown));
        if status.transient() {
            let (tx, shown) = (self.tx.clone(), self.shown);
            crate::rt::after_ms(DONE_MS, move || {
                let _ = tx.unbounded_send(Msg::HideStatus(shown));
            });
        }
    }

    fn hide_status(&mut self) {
        self.status = None;
    }

    fn show_error(&mut self, title: &str, message: &str, prose: bool) {
        self.error = Some(DevError {
            title: title.to_owned(),
            message: clean_message(message).into_owned(),
            prose,
        });
    }
}

/// Connects `this` to the dev server at `url` (`ws://host:port/ws`),
/// replacing its session if it had one.
pub(crate) fn start(this: &AppView, url: String, cx: &mut Context<AppView>) {
    let (tx, mut rx) = unbounded::<Msg>();
    if let Some(base) = asset_base(&url) {
        this.set_asset_base(Some(AssetBase::Http(base)));
    }
    let surface = this.surface();
    let previous = this.dev.borrow_mut().take();
    let reloads = match previous {
        Some(previous) => {
            *previous.reloads.borrow_mut() = tx.clone();
            previous.reloads.clone()
        }
        None => {
            let reloads = Rc::new(RefCell::new(tx.clone()));
            let sender = reloads.clone();
            surface.shortcuts.borrow_mut().push(Box::new(move |event| {
                if !is_reload_key(event) {
                    return false;
                }
                if !event.repeat {
                    let _ = sender.borrow().unbounded_send(Msg::Reload);
                }
                true
            }));
            reloads
        }
    };
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let mut session = DevSession {
        id,
        _client: None,
        tx: tx.clone(),
        reloads,
        running: None,
        latest: None,
        status: None,
        shown: 0,
        error: None,
    };
    session.show_status(Status::Connecting(&url));

    // Next to the embedding app's handler (`AppView::on_error`), which
    // hears the errors too.
    let errors = tx.clone();
    surface.set_dev_error_handler(Box::new(move |error| {
        let _ = errors.unbounded_send(Msg::RuntimeError(error.clone()));
    }));
    let failed = tx.clone();
    surface.set_hot_update_failed(move || {
        let _ = failed.unbounded_send(Msg::HotUpdateFailed);
    });

    let host = HostInfo {
        device: device_name(host_name().as_deref()),
        platform: HostPlatform::Gpui,
        bytecode_version: BYTECODE_VERSION.to_owned(),
        ui_sets: crate::app::ui_sets()
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .filter_map(|set| set.specifier().map(str::to_owned))
            .collect(),
        tests: true,
    };
    // A test session (`nsh test --target gpui`): the model goes to the
    // surface through the session's messages, ahead of the bundle.
    let models = tx.clone();
    let key = surface.key();
    let tester = nsh_testing::agent::Tester::new(move |model| {
        let _ = models.unbounded_send(Msg::TestModel(model));
        Box::new(crate::agent::GpuiNative::new(key))
    });
    let tests = tester.clone();
    let events = tx;
    let started = DevClient::start(url, host, move |event| {
        // Taken here: a step waits for what it does on the main thread.
        let Some(event) = tests.event(event) else {
            return;
        };
        match event {
            DevEvent::Connected => CONNECTED.store(true, Ordering::Relaxed),
            DevEvent::Disconnected => CONNECTED.store(false, Ordering::Relaxed),
            _ => {}
        }
        let _ = events.unbounded_send(Msg::Event(event));
    });
    match started {
        Ok(client) => {
            let client = Arc::new(client);
            tester.set_client(&client);
            *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(&client);
            session._client = Some(client);
        }
        Err(err) => {
            log::error!("cannot start the dev client: {err}");
            session.hide_status();
            session.show_error("Cannot connect", &err.to_string(), true);
        }
    }
    *this.dev.borrow_mut() = Some(session);

    cx.spawn(async move |weak, cx| {
        use futures_util::StreamExt;
        while let Some(msg) = rx.next().await {
            // A burst (a bundle right after "building") is handled in one
            // update, drawn once.
            let mut msgs = vec![msg];
            while let Ok(msg) = rx.try_recv() {
                msgs.push(msg);
            }
            let current = weak.update(cx, |view, cx| {
                // Replaced by another session: what this one sent is stale.
                if view.dev.borrow().as_ref().map(|s| s.id) != Some(id) {
                    return false;
                }
                for msg in msgs {
                    handle(view, msg);
                }
                cx.notify();
                crate::rt::flush(cx);
                true
            });
            if !matches!(current, Ok(true)) {
                break;
            }
        }
    })
    .detach();
}

/// Ctrl+R (Cmd+R on macOS) and F5 load the latest build again, wherever
/// the window's focus is.
fn is_reload_key(event: &KeyEvent) -> bool {
    const VK_R: u16 = 0x52;
    const VK_F5: u16 = 0x74;
    let m = event.modifiers;
    let command = if cfg!(target_os = "macos") {
        m.meta && !m.ctrl
    } else {
        m.ctrl && !m.meta
    };
    event.down
        && match event.vk {
            VK_R => command && !m.alt && !m.shift,
            VK_F5 => !m.ctrl && !m.alt && !m.shift && !m.meta,
            _ => false,
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

/// This machine's name, where the system says it without a call.
fn host_name() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
}

/// The name the developer's terminal shows for this host.
fn device_name(host: Option<&str>) -> String {
    let os = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "Linux"
    };
    match host.map(str::trim) {
        Some(name) if !name.is_empty() && name != "localhost" => format!("GPUI ({os}, {name})"),
        _ => format!("GPUI ({os})"),
    }
}

fn handle(view: &AppView, msg: Msg) {
    let mut dev = view.dev.borrow_mut();
    let Some(session) = dev.as_mut() else { return };
    let load = match msg {
        Msg::Event(event) => on_event(view, session, event),
        Msg::RuntimeError(error) => {
            session.show_error(error_title(&error), &error.to_string(), false);
            None
        }
        Msg::HotUpdateFailed => reload(session).map(App::Js),
        Msg::Reload => reload_latest(session).map(App::Js),
        Msg::HideStatus(shown) => {
            if session.status.as_ref().is_some_and(|s| s.1 == shown) {
                session.hide_status();
            }
            None
        }
        Msg::TestModel(model) => {
            view.surface().set_test_model(Some(model));
            None
        }
    };
    drop(dev);
    if let Some(app) = load {
        view.load(app);
    }
}

/// The overlay's title for an error of the app.
fn error_title(error: &AppError) -> &'static str {
    match error.kind {
        AppErrorKind::Load => "The app failed to load",
        AppErrorKind::Stopped => "The app was stopped",
        AppErrorKind::HotUpdate => "Update failed",
        AppErrorKind::Asset => "Cannot load a file",
        _ => "Uncaught error",
    }
}

/// Handles one event of the dev client; returns the app to load.
fn on_event(view: &AppView, dev: &mut DevSession, event: DevEvent) -> Option<App> {
    match event {
        DevEvent::Connected => dev.hide_status(),
        DevEvent::Disconnected => dev.show_status(Status::Reconnecting),
        // The client's thread hands them to the test agent.
        DevEvent::Testing
        | DevEvent::Step { .. }
        | DevEvent::TestSetup { .. }
        | DevEvent::Fetch { .. } => {}
        DevEvent::Root => {
            dev.hide_status();
            let Some(root) = crate::app::root() else {
                dev.show_error(
                    "This host cannot run the app",
                    "The app is of Rust only, and this host was not built with its root.",
                    true,
                );
                return None;
            };
            dev.latest = None;
            dev.running = None;
            dev.error = None;
            return Some(App::Rust(root));
        }
        DevEvent::Building => dev.show_status(Status::Building),
        DevEvent::BuildFailed(message) => {
            dev.hide_status();
            dev.show_error("Build failed", &message, false)
        }
        DevEvent::CannotRun { message, .. } => {
            dev.hide_status();
            dev.show_error("This host cannot run the app", &message, true)
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
            // A bundle reached through a hot update keeps its "Updated".
            if dev.running != Some((session, version)) {
                dev.hide_status();
            }
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
                        dev.show_error(
                            "Invalid bundle",
                            "the dev server sent non-UTF-8 source",
                            true,
                        );
                        return None;
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
                Err(err) => {
                    dev.show_error("Invalid capabilities", &err, true);
                    return None;
                }
            };
            let limits = match Limits::development(limits.as_deref()) {
                Ok(limits) => limits,
                Err(err) => {
                    dev.show_error("Invalid limits", &err, true);
                    return None;
                }
            };
            dev.latest = Some((session, version, bundle.clone()));
            let running = dev.running.replace((session, version));
            // Already there through a hot update.
            if running == Some((session, version)) {
                return None;
            }
            log::info!("loading build {version}");
            view.set_limits(limits);
            dev.error = None;
            if running.is_some() {
                dev.show_status(Status::Reloaded);
            }
            return Some(App::Js(bundle));
        }
        DevEvent::Patch {
            session,
            version,
            base,
            code,
            source_map,
        } => {
            if dev.running != Some((session, base)) {
                // Not for the running build: its bundle follows.
                return None;
            }
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
                dev.running = Some((session, version));
                dev.error = None;
                dev.show_status(Status::Updated);
            }
        }
    }
    None
}

/// A hot update could not be applied in place: the build to load from
/// scratch, or none while that bundle is still on its way (it loads when it
/// comes).
fn reload(dev: &mut DevSession) -> Option<Bundle> {
    let target = dev.running.take();
    let bundle = match &dev.latest {
        Some((session, version, bundle)) if Some((*session, *version)) == target => bundle.clone(),
        _ => return None,
    };
    dev.running = target;
    log::info!("reloading after an update that could not be applied in place");
    dev.show_status(Status::Reloaded);
    Some(bundle)
}

/// The latest build, to load from scratch (the reload key).
fn reload_latest(dev: &mut DevSession) -> Option<Bundle> {
    let (session, version, bundle) = dev.latest.clone()?;
    dev.running = Some((session, version));
    log::info!("reloading");
    dev.error = None;
    dev.show_status(Status::Reloaded);
    Some(bundle)
}

/// The view's content: `surface` alone, or, with a dev session, under its
/// status line and error overlay.
pub(crate) fn wrap(view: &AppView, surface: AnyElement, cx: &mut Context<AppView>) -> AnyElement {
    let dev = view.dev.borrow();
    let Some(dev) = dev.as_ref() else {
        return surface;
    };
    let mut root = div().relative().size_full().child(surface);
    if let Some(error) = &dev.error {
        root = root.child(error_overlay(error, cx));
    }
    if let Some((text, _)) = &dev.status {
        root = root.child(status_line(text));
    }
    root.into_any_element()
}

/// A pill at the top center; information only: it takes no input, so the
/// app below keeps it.
fn status_line(text: &str) -> impl IntoElement {
    div()
        .absolute()
        .top(px(10.0))
        .left(px(16.0))
        .right(px(16.0))
        .flex()
        .justify_center()
        .child(
            div()
                .max_w_full()
                .overflow_hidden()
                .px(px(14.0))
                .py(px(6.0))
                .rounded_full()
                .bg(rgba(0x1a1a1ad9))
                .text_color(rgba(0xffffffff))
                .text_size(px(12.0))
                .font_weight(FontWeight::SEMIBOLD)
                .whitespace_nowrap()
                .text_ellipsis()
                .child(text.to_owned()),
        )
}

/// The error over the whole app (it takes the app's input while shown); a
/// click dismisses it, the wheel scrolls it.
fn error_overlay(error: &DevError, cx: &mut Context<AppView>) -> impl IntoElement {
    let hint = if cfg!(target_os = "macos") {
        "Click to dismiss · Cmd+R to reload"
    } else {
        "Click to dismiss · Ctrl+R to reload"
    };
    let mut message = div().text_size(px(12.0));
    if let Some(family) = monospace(cx) {
        message = message.font_family(family);
    }
    let message = message.line_height(px(17.0)).child(error.message.clone());
    let message = if error.prose {
        message
    } else {
        message.whitespace_nowrap()
    };
    div()
        .id("nsh-dev-error")
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .occlude()
        .bg(rgba(0x8c1414f7))
        .text_color(rgba(0xffffffff))
        .overflow_scroll()
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|view, _, _, cx| {
                if let Some(dev) = view.dev.borrow_mut().as_mut() {
                    dev.error = None;
                }
                cx.notify();
            }),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .pt(px(20.0))
                .pb(px(24.0))
                .px(px(16.0))
                .child(
                    div()
                        .text_size(px(16.0))
                        .font_weight(FontWeight::BOLD)
                        .child(error.title.clone()),
                )
                .child(message)
                .child(div().text_size(px(11.0)).opacity(0.7).child(hint)),
        )
}

/// The family code is shown in: the first of the platform's usual
/// monospace families that is installed (GPUI resolves exact names only,
/// no generic `monospace`), looked up once.
fn monospace(cx: &GpuiApp) -> Option<SharedString> {
    thread_local!(static FAMILY: std::cell::OnceCell<Option<SharedString>> = const { std::cell::OnceCell::new() });
    FAMILY.with(|family| {
        family
            .get_or_init(|| crate::text::monospace_family(cx.text_system()))
            .clone()
    })
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Modifiers;

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
    }

    #[test]
    fn status_texts() {
        assert_eq!(
            Status::Connecting("ws://h:1/ws").text(),
            "Connecting to ws://h:1/ws…"
        );
        assert_eq!(Status::Building.text(), "Building…");
        assert!(Status::Reloaded.transient() && Status::Updated.transient());
        assert!(!Status::Reconnecting.transient() && !Status::Building.transient());
    }

    #[test]
    fn device_names() {
        let os = device_name(None);
        assert!(os.starts_with("GPUI (") && os.ends_with(')'));
        assert_eq!(device_name(Some(" \n")), os);
        assert_eq!(device_name(Some("localhost")), os);
        let named = device_name(Some("box\n"));
        assert!(named.ends_with(", box)"), "{named}");
    }

    #[test]
    fn reload_keys() {
        let key = |vk, modifiers| KeyEvent {
            vk,
            down: true,
            repeat: false,
            modifiers,
        };
        let command = if cfg!(target_os = "macos") {
            Modifiers {
                meta: true,
                ..Modifiers::default()
            }
        } else {
            Modifiers {
                ctrl: true,
                ..Modifiers::default()
            }
        };
        assert!(is_reload_key(&key(0x52, command)));
        assert!(is_reload_key(&key(0x74, Modifiers::default())));
        assert!(!is_reload_key(&key(0x52, Modifiers::default())));
        let shifted = Modifiers {
            shift: true,
            ..command
        };
        assert!(!is_reload_key(&key(0x52, shifted)));
        let mut up = key(0x52, command);
        up.down = false;
        assert!(!is_reload_key(&up));
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
}
