//! Development host support: connects to the `nsh` dev server, loads every
//! pushed bundle, forwards logs to the developer's terminal and shows build
//! and runtime errors on screen.
//!
//! The dev client runs on its own thread; each of its events hops to the
//! GTK main thread with `MainContext::invoke`, which needs `Send` closures,
//! so the session's state lives in a thread-local map and events find it
//! by key (as the engine's batches find their surface).

use std::{
    cell::RefCell,
    io::Write,
    rc::{Rc, Weak},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use gtk4::{self as gtk, gdk, glib, prelude::*};
use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{App, BYTECODE_VERSION, Bundle, HotUpdate, Limits, Policy};
use rustc_hash::FxHashMap;

use crate::{app::AppView, image::AssetBase};

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
    view: Weak<AppView>,
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle with its server run and number, for reloads.
    latest: Option<(u64, u64, Bundle)>,
    status: Option<gtk::Label>,
    error: Option<gtk::Widget>,
}

/// Connects `view` to the dev server at `url` (`ws://host:port/ws`).
pub(crate) fn start(view: &Rc<AppView>, url: String) {
    install_css();
    if let Some(base) = asset_base(&url) {
        view.set_asset_base(Some(AssetBase::Http(base)));
    }
    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
    let ui = Rc::new(RefCell::new(DevUi {
        view: Rc::downgrade(view),
        running: None,
        latest: None,
        status: None,
        error: None,
    }));
    SESSIONS.with(|s| s.borrow_mut().insert(key, ui.clone()));
    show_status(&ui, &format!("Connecting to {url}…"));
    install_reload_key(view, key);

    let surface = view.surface();
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

    let host = HostInfo {
        device: device_name(),
        platform: HostPlatform::Linux,
        bytecode_version: BYTECODE_VERSION.to_owned(),
        ui_sets: crate::app::ui_sets()
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .filter_map(|set| set.specifier().map(str::to_owned))
            .collect(),
        tests: true,
    };
    // A test session (`nsh test --target linux`): the surface keeps the
    // model the agent's steps see, from the first bundle on (idle sources
    // keep their order, so it comes before the bundle).
    let key_of_surface = surface.key();
    let tester = nsh_testing::agent::Tester::new(move |model| {
        glib::MainContext::default().invoke(move || {
            if let Some(surface) = crate::surface::Surface::by_key(key_of_surface) {
                surface.set_test_model(Some(model));
            }
        });
        Box::new(crate::agent::LinuxNative::new(key_of_surface))
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
        // Idle sources of one priority run in the order they were added,
        // so events keep theirs.
        glib::MainContext::default().invoke(move || {
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

fn device_name() -> String {
    let host = glib::host_name();
    if host.is_empty() || host == "localhost" {
        "Linux".to_owned()
    } else {
        format!("Linux ({host})")
    }
}

fn handle(ui: &Rc<RefCell<DevUi>>, event: DevEvent) {
    match event {
        DevEvent::Connected => hide_status(ui),
        DevEvent::Disconnected => show_status(ui, "Dev server disconnected — reconnecting…"),
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
        DevEvent::Building => show_status(ui, "Building…"),
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

/// Loads the latest build from scratch (Ctrl+R).
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

/// Ctrl+R in the window of `view` loads the latest build again: a global
/// shortcut, which the window handles wherever its focus is, and which
/// matches the key of the layout's Latin group under other layouts.
fn install_reload_key(view: &AppView, key: u64) {
    let action = gtk::CallbackAction::new(move |_, _| match session(key) {
        Some(ui) => {
            reload_latest(&ui);
            glib::Propagation::Stop
        }
        None => glib::Propagation::Proceed,
    });
    let shortcut = gtk::Shortcut::new(
        gtk::ShortcutTrigger::parse_string("<Control>r"),
        Some(action),
    );
    let controller = gtk::ShortcutController::new();
    controller.set_scope(gtk::ShortcutScope::Global);
    controller.add_shortcut(shortcut);
    view.overlay().add_controller(controller);
}

/// Styles of the status line and the error overlay, once per process.
fn install_css() {
    thread_local!(static INSTALLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if INSTALLED.with(|i| i.replace(true)) {
        return;
    }
    let Some(display) = gdk::Display::default() else {
        return;
    };
    let provider = gtk::CssProvider::new();
    provider.load_from_string(
        ".nsh-dev-status { background: rgba(26, 26, 26, 0.85); color: white; font-size: 12px; \
         font-weight: 600; padding: 6px 14px; border-radius: 999px; }
         .nsh-dev-error { background: rgba(30, 31, 34, 0.98); color: white; }
         .nsh-dev-error label { color: white; }
         .nsh-dev-error .nsh-dev-title { font-size: 16px; font-weight: 700; color: #ff6b6b; }
         .nsh-dev-error .nsh-dev-copy { background: rgba(255, 255, 255, 0.12); background-image: none; \
         border: none; box-shadow: none; color: white; font-size: 13px; font-weight: 600; \
         padding: 4px 14px; border-radius: 6px; min-width: 52px; }
         .nsh-dev-error .nsh-dev-copy:hover { background: rgba(255, 255, 255, 0.2); }
         .nsh-dev-error .nsh-dev-message { font-family: monospace; font-size: 12px; }
         .nsh-dev-error .nsh-dev-hint { font-size: 11px; opacity: 0.7; }
         .nsh-dev-error .nsh-dev-message selection { background: rgba(255, 255, 255, 0.35); }",
    );
    gtk::style_context_add_provider_for_display(
        &display,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}

fn show_status(ui: &RefCell<DevUi>, text: &str) {
    let mut ui = ui.borrow_mut();
    if let Some(label) = &ui.status {
        label.set_text(text);
        return;
    }
    let Some(view) = ui.view.upgrade() else {
        return;
    };
    let label = gtk::Label::new(Some(text));
    label.add_css_class("nsh-dev-status");
    label.set_halign(gtk::Align::Center);
    label.set_valign(gtk::Align::Start);
    label.set_margin_top(10);
    label.set_margin_start(16);
    label.set_margin_end(16);
    label.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
    // Information only: the app below keeps its input.
    label.set_can_target(false);
    view.overlay().add_overlay(&label);
    ui.status = Some(label);
}

fn hide_status(ui: &RefCell<DevUi>) {
    let mut ui = ui.borrow_mut();
    if let (Some(label), Some(view)) = (ui.status.take(), ui.view.upgrade()) {
        view.overlay().remove_overlay(&label);
    }
}

/// Shows `title` and `message` over the whole app; a click dismisses it
/// (unless it selected text to copy), its Copy button copies them. `prose` wraps the message to the
/// view; otherwise its lines are kept (code frames, stack traces) and it
/// scrolls sideways.
fn show_error(ui: &Rc<RefCell<DevUi>>, title: &str, message: &str, prose: bool) {
    hide_error(ui);
    let Some(view) = ui.borrow().view.upgrade() else {
        return;
    };
    let content = gtk::Box::new(gtk::Orientation::Vertical, 12);
    content.set_margin_top(20);
    content.set_margin_bottom(24);
    content.set_margin_start(16);
    content.set_margin_end(16);

    let heading = gtk::Label::new(Some(title));
    heading.add_css_class("nsh-dev-title");
    heading.set_xalign(0.0);
    content.append(&heading);

    let text = gtk::Label::new(Some(message));
    text.add_css_class("nsh-dev-message");
    text.set_xalign(0.0);
    text.set_yalign(0.0);
    text.set_selectable(true);
    text.set_wrap(prose);
    text.set_wrap_mode(gtk::pango::WrapMode::WordChar);
    content.append(&text);

    let hint = gtk::Label::new(Some("Click to dismiss · Ctrl+R to reload"));
    hint.add_css_class("nsh-dev-hint");
    hint.set_xalign(0.0);
    content.append(&hint);

    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(
        if prose {
            gtk::PolicyType::Never
        } else {
            gtk::PolicyType::Automatic
        },
        gtk::PolicyType::Automatic,
    );
    scroll.set_child(Some(&content));
    scroll.set_hexpand(true);
    scroll.set_vexpand(true);

    // Captured before the selectable label sees the click, so a click
    // anywhere dismisses; one that selected text does not.
    let click = gtk::GestureClick::new();
    click.set_propagation_phase(gtk::PropagationPhase::Capture);
    let weak = Rc::downgrade(ui);
    let label = text.clone();
    click.connect_released(move |_, n_press, _, _| {
        if n_press == 1
            && label.selection_bounds().is_none()
            && let Some(ui) = weak.upgrade()
        {
            hide_error(&ui);
        }
    });
    scroll.add_controller(click);

    // Beside the text, not in it: its clicks do not reach the dismissing
    // gesture above.
    let copy = gtk::Button::with_label("Copy");
    copy.add_css_class("nsh-dev-copy");
    copy.set_halign(gtk::Align::End);
    copy.set_valign(gtk::Align::Start);
    copy.set_margin_top(14);
    copy.set_margin_end(24);
    let error = format!("{title}\n\n{message}");
    copy.connect_clicked(move |button| {
        if let Some(display) = gdk::Display::default() {
            display.clipboard().set_text(&error);
        }
        button.set_label("Copied");
    });

    let layer = gtk::Overlay::new();
    layer.add_css_class("nsh-dev-error");
    layer.set_child(Some(&scroll));
    layer.add_overlay(&copy);
    view.overlay().add_overlay(&layer);
    ui.borrow_mut().error = Some(layer.upcast());
}

fn hide_error(ui: &RefCell<DevUi>) {
    let mut ui = ui.borrow_mut();
    if let (Some(error), Some(view)) = (ui.error.take(), ui.view.upgrade()) {
        view.overlay().remove_overlay(&error);
    }
}

#[cfg(test)]
mod tests {
    use super::asset_base;

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
}
