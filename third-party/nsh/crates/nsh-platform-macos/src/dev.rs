//! Development host support: connects to the `nsh` dev server, loads every
//! pushed bundle, forwards logs to the developer's terminal and shows build
//! and runtime errors on screen.
//!
//! The dev client runs on its own thread; each of its events hops to the
//! main queue, which needs `Send` closures, so the session's state lives
//! in a thread-local map and events find it by key (as the engine's
//! batches find their surface).
//!
//! The status line ("Connecting…", "Building…") and the error overlay are
//! AppKit views above the surface in [`AppView`]'s container. The status
//! line lets the pointer through; the overlay takes it, and a click that
//! selects no text dismisses it; its Copy button puts the error on the
//! pasteboard. Cmd+R loads the latest build again.

use std::{
    cell::RefCell,
    io::Write,
    ptr::NonNull,
    rc::{Rc, Weak},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{App, BYTECODE_VERSION, Bundle, HotUpdate, Limits, Policy};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
    runtime::AnyObject, sel,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBezelStyle, NSButton, NSColor, NSControl, NSEvent, NSEventMask,
    NSEventModifierFlags, NSFont, NSFontAttributeName, NSFontWeightRegular, NSFontWeightSemibold,
    NSForegroundColorAttributeName, NSLineBreakMode, NSPasteboard, NSPasteboardTypeString,
    NSResponder, NSScrollView, NSText, NSTextField, NSTextView, NSView,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRange, NSRect, NSSize, NSString};
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
    /// The Cmd+R key monitor.
    monitor: Option<Retained<AnyObject>>,
}

impl Drop for DevSession {
    fn drop(&mut self) {
        if let Some(monitor) = self.monitor.take() {
            // SAFETY: a monitor `addLocalMonitorForEventsMatchingMask`
            // returned.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
        let key = self.key;
        // Dropped during thread teardown: the map may be gone already.
        let ui = SESSIONS
            .try_with(|s| s.borrow_mut().remove(&key))
            .ok()
            .flatten();
        if let Some(ui) = &ui {
            hide_status(ui);
            hide_error(ui);
        }
        drop(ui);
    }
}

/// What a session shows and runs.
struct DevUi {
    key: u64,
    view: Weak<AppView>,
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle with its server run and number, for reloads.
    latest: Option<(u64, u64, Bundle)>,
    /// The status line: a pill holding its label.
    status: Option<(Retained<NSView>, Retained<NSTextField>)>,
    error: Option<Retained<NSView>>,
}

/// Connects `view` to the dev server at `url` (`ws://host:port/ws`).
pub(crate) fn start(view: &Rc<AppView>, url: String) {
    if let Some(base) = asset_base(&url) {
        view.set_asset_base(Some(AssetBase::Http(base)));
    }
    let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
    let ui = Rc::new(RefCell::new(DevUi {
        key,
        view: Rc::downgrade(view),
        running: None,
        latest: None,
        status: None,
        error: None,
    }));
    SESSIONS.with(|s| s.borrow_mut().insert(key, ui.clone()));
    show_status(&ui, &format!("Connecting to {url}…"));

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
        platform: HostPlatform::MacOs,
        bytecode_version: BYTECODE_VERSION.to_owned(),
        ui_sets: crate::app::ui_sets()
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .filter_map(|set| set.specifier().map(str::to_owned))
            .collect(),
        tests: true,
    };
    // A test session (`nsh test --target macos`): the surface keeps the
    // model the agent's steps see, from the first bundle on.
    let key_of_surface = surface.key();
    let tester = nsh_testing::agent::Tester::new(move |model| {
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = crate::surface::Surface::with_key(key_of_surface) {
                surface.set_test_model(Some(model));
            }
        });
        Box::new(crate::agent::MacNative::new(key_of_surface))
    });
    let tests = tester.clone();
    let started = DevClient::start(url, host, move |event| {
        // Taken off the main queue: a step waits for what it does there.
        let Some(event) = tests.event(event) else {
            return;
        };
        match event {
            DevEvent::Connected => CONNECTED.store(true, Ordering::Relaxed),
            DevEvent::Disconnected => CONNECTED.store(false, Ordering::Relaxed),
            _ => {}
        }
        // The main queue is serial: events keep their order.
        DispatchQueue::main().exec_async(move || {
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
                monitor: reload_key(key),
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
    let mut buf = [0u8; 256];
    // SAFETY: `buf` is writable for its length; the name is NUL-terminated
    // when it fits.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let host = if ok {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };
    let host = host.trim_end_matches(".local");
    if host.is_empty() || host == "localhost" {
        "macOS".to_owned()
    } else {
        format!("macOS ({host})")
    }
}

/// Cmd+R in the session's window loads the latest build again.
fn reload_key(key: u64) -> Option<Retained<AnyObject>> {
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event.
        let e = unsafe { event.as_ref() };
        let command = e
            .modifierFlags()
            .intersection(NSEventModifierFlags::DeviceIndependentFlagsMask)
            == NSEventModifierFlags::Command;
        let r = crate::input::shortcut_key(e) == Some('r');
        if command
            && r
            && let Some(ui) = session(key)
            && in_window(&ui, e)
        {
            reload_latest(&ui);
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    // SAFETY: the block returns the event it got, or null (handled); the
    // monitor is removed when the session drops.
    unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block) }
}

/// Whether `event` happened in the window showing the session's view.
fn in_window(ui: &RefCell<DevUi>, event: &NSEvent) -> bool {
    let Some(view) = ui.borrow().view.upgrade() else {
        return false;
    };
    let mtm = MainThreadMarker::new().expect("main thread");
    let ours = view.container().window();
    event
        .window(mtm)
        .is_some_and(|w| ours.as_deref() == Some(&*w))
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

/// Loads the latest build from scratch (Cmd+R).
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

define_class!(
    /// The status line's pill: lets the pointer through to the app.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshDevStatus"]
    struct StatusView;

    unsafe impl NSObjectProtocol for StatusView {}

    impl StatusView {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

/// Horizontal and vertical padding of the status line's text.
const STATUS_PADDING: (f64, f64) = (14.0, 6.0);

fn show_status(ui: &RefCell<DevUi>, text: &str) {
    let mut ui = ui.borrow_mut();
    let Some(view) = ui.view.upgrade() else {
        return;
    };
    let container = view.container();
    let (pill, label) = match &ui.status {
        Some((pill, label)) => (pill.clone(), label.clone()),
        None => {
            let mtm = MainThreadMarker::new().expect("main thread");
            // SAFETY: NSView's designated initializer.
            let pill: Retained<StatusView> =
                unsafe { msg_send![StatusView::alloc(mtm), initWithFrame: NSRect::ZERO] };
            let pill: Retained<NSView> = Retained::into_super(pill);
            pill.setWantsLayer(true);
            if let Some(layer) = pill.layer() {
                let fill = NSColor::colorWithSRGBRed_green_blue_alpha(0.1, 0.1, 0.1, 0.85);
                layer.setBackgroundColor(Some(&fill.CGColor()));
            }
            let label = NSTextField::labelWithString(&NSString::new(), mtm);
            // SAFETY: AppKit's font weight constant.
            let weight = unsafe { NSFontWeightSemibold };
            label.setFont(Some(&NSFont::systemFontOfSize_weight(12.0, weight)));
            label.setTextColor(Some(&NSColor::whiteColor()));
            label.setLineBreakMode(NSLineBreakMode::ByTruncatingMiddle);
            pill.addSubview(&label);
            container.addSubview(&pill);
            ui.status = Some((pill.clone(), label.clone()));
            (pill, label)
        }
    };
    label.setStringValue(&NSString::from_str(text));
    // Centered at the top, at most the width of the view less margins.
    let bounds = container.bounds();
    let fit = label.fittingSize();
    let width = fit
        .width
        .min(bounds.size.width - 32.0 - 2.0 * STATUS_PADDING.0)
        .max(0.0);
    let size = NSSize::new(
        width + 2.0 * STATUS_PADDING.0,
        fit.height + 2.0 * STATUS_PADDING.1,
    );
    // The container is not flipped: y grows upwards.
    pill.setFrame(NSRect::new(
        NSPoint::new(
            ((bounds.size.width - size.width) / 2.0).round(),
            bounds.size.height - 10.0 - size.height,
        ),
        size,
    ));
    pill.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewMinXMargin
            | NSAutoresizingMaskOptions::ViewMaxXMargin
            | NSAutoresizingMaskOptions::ViewMinYMargin,
    );
    if let Some(layer) = pill.layer() {
        layer.setCornerRadius(size.height / 2.0);
    }
    label.setFrame(NSRect::new(
        NSPoint::new(STATUS_PADDING.0, STATUS_PADDING.1),
        NSSize::new(width, fit.height),
    ));
}

fn hide_status(ui: &RefCell<DevUi>) {
    if let Some((pill, _)) = ui.borrow_mut().status.take() {
        pill.removeFromSuperview();
    }
}

define_class!(
    /// The error overlay's text: selectable; a click that selects nothing
    /// dismisses the overlay.
    #[unsafe(super(NSTextView, NSText, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = u64]
    #[name = "NshDevErrorText"]
    struct ErrorText;

    unsafe impl NSObjectProtocol for ErrorText {}

    impl ErrorText {
        /// A click in an inactive window dismisses too (the app's views
        /// take first clicks as well).
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            // NSTextView tracks the mouse until it goes up.
            // SAFETY: NSTextView's own handling.
            let _: () = unsafe { msg_send![super(self), mouseDown: event] };
            if self.selectedRange().length == 0
                && let Some(ui) = session(*self.ivars())
            {
                hide_error(&ui);
            }
        }
    }
);

define_class!(
    /// The error overlay: takes every click (the app below gets none while
    /// it shows); a click outside the text dismisses it.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = u64]
    #[name = "NshDevError"]
    struct ErrorView;

    unsafe impl NSObjectProtocol for ErrorView {}

    impl ErrorView {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            if let Some(ui) = session(*self.ivars()) {
                hide_error(&ui);
            }
        }

        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, _event: &NSEvent) {}
    }
);

define_class!(
    /// The error overlay's Copy button: puts the title and message on the
    /// pasteboard (selecting a long stack trace by hand is error-prone).
    #[unsafe(super(NSButton, NSControl, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = String]
    #[name = "NshDevErrorCopy"]
    struct CopyButton;

    unsafe impl NSObjectProtocol for CopyButton {}

    impl CopyButton {
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        #[unsafe(method(copyError:))]
        fn copy_error(&self, _sender: Option<&AnyObject>) {
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            // SAFETY: an immutable AppKit constant.
            pasteboard.setString_forType(&NSString::from_str(self.ivars()), unsafe {
                NSPasteboardTypeString
            });
            self.setTitle(&NSString::from_str("Copied"));
        }
    }
);

/// Adds the Copy button for `text` to the top right corner of `overlay`.
fn add_copy_button(overlay: &NSView, text: String, mtm: MainThreadMarker) {
    let button = CopyButton::alloc(mtm).set_ivars(text);
    // SAFETY: NSButton's designated initializer.
    let button: Retained<CopyButton> =
        unsafe { msg_send![super(button), initWithFrame: NSRect::ZERO] };
    button.setTitle(&NSString::from_str("Copy"));
    button.setBezelStyle(NSBezelStyle::Push);
    // SAFETY: the button is its own target (controls do not retain their
    // target) and implements the action.
    unsafe {
        button.setTarget(Some(&button));
        button.setAction(Some(sel!(copyError:)));
    }
    button.sizeToFit();
    // Wide enough for "Copied" too, so the button keeps its size.
    let size = NSSize::new(
        button.frame().size.width.max(84.0),
        button.frame().size.height,
    );
    let bounds = overlay.bounds();
    // Unflipped: the top is the high y. Clear of the vertical scroller.
    button.setFrame(NSRect::new(
        NSPoint::new(
            bounds.size.width - size.width - 28.0,
            bounds.size.height - size.height - 14.0,
        ),
        size,
    ));
    button.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewMinYMargin,
    );
    overlay.addSubview(&button);
}

/// Shows `title` and `message` over the whole app; a click dismisses it
/// (unless it selected text to copy). `prose` wraps the message to the
/// view; otherwise its lines are kept (code frames, stack traces) and it
/// scrolls sideways.
fn show_error(ui: &Rc<RefCell<DevUi>>, title: &str, message: &str, prose: bool) {
    hide_error(ui);
    let (view, key) = {
        let ui = ui.borrow();
        (ui.view.upgrade(), ui.key)
    };
    let Some(view) = view else { return };
    let container = view.container();
    let mtm = MainThreadMarker::new().expect("main thread");
    let bounds = container.bounds();
    let fill =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;

    let overlay = ErrorView::alloc(mtm).set_ivars(key);
    // SAFETY: NSView's designated initializer.
    let overlay: Retained<ErrorView> = unsafe { msg_send![super(overlay), initWithFrame: bounds] };
    let overlay: Retained<NSView> = Retained::into_super(overlay);
    overlay.setAutoresizingMask(fill);
    overlay.setWantsLayer(true);
    if let Some(layer) = overlay.layer() {
        // Opaque: the app's own text must not show through the message.
        let dark = NSColor::colorWithSRGBRed_green_blue_alpha(0.118, 0.122, 0.133, 1.0);
        layer.setBackgroundColor(Some(&dark.CGColor()));
    }

    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), overlay.bounds());
    scroll.setAutoresizingMask(fill);
    scroll.setDrawsBackground(false);
    scroll.setHasVerticalScroller(true);
    scroll.setHasHorizontalScroller(!prose);
    scroll.setAutohidesScrollers(true);

    let text = ErrorText::alloc(mtm).set_ivars(key);
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), scroll.contentSize());
    // SAFETY: NSTextView's designated initializer.
    let text: Retained<ErrorText> = unsafe { msg_send![super(text), initWithFrame: frame] };
    text.setEditable(false);
    text.setSelectable(true);
    text.setDrawsBackground(false);
    text.setRichText(false);
    text.setTextContainerInset(NSSize::new(16.0, 20.0));
    text.setVerticallyResizable(true);
    text.setMaxSize(NSSize::new(f64::MAX, f64::MAX));
    text.setMinSize(frame.size);
    if prose {
        text.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable);
    } else {
        // As wide as its longest line (`sizeToFit` below), so it scrolls
        // sideways to the ends of long lines.
        text.setHorizontallyResizable(true);
        // SAFETY: a plain getter; the text view keeps its container.
        if let Some(c) = unsafe { text.textContainer() } {
            c.setWidthTracksTextView(false);
            c.setContainerSize(NSSize::new(f64::MAX, f64::MAX));
        }
    }

    let hint = "Click to dismiss · Cmd+R to reload";
    let all = format!("{title}\n\n{message}\n\n{hint}");
    text.setString(&NSString::from_str(&all));
    let units = |s: &str| s.encode_utf16().count();
    let title_len = units(title);
    let message_at = title_len + 2;
    let hint_at = message_at + units(message) + 2;
    // SAFETY: plain getters; AppKit's attribute name and weight constants.
    unsafe {
        if let Some(storage) = text.textStorage() {
            let whole = NSRange::new(0, units(&all));
            let ranges = [
                (
                    NSRange::new(0, title_len),
                    NSFont::systemFontOfSize_weight(16.0, NSFontWeightSemibold),
                ),
                (
                    NSRange::new(message_at, units(message)),
                    NSFont::monospacedSystemFontOfSize_weight(12.0, NSFontWeightRegular),
                ),
                (
                    NSRange::new(hint_at, units(hint)),
                    NSFont::systemFontOfSize_weight(11.0, NSFontWeightRegular),
                ),
            ];
            storage.addAttribute_value_range(
                NSForegroundColorAttributeName,
                &NSColor::whiteColor(),
                whole,
            );
            for (range, font) in ranges {
                storage.addAttribute_value_range(NSFontAttributeName, &font, range);
            }
            // The title alone says it is an error, in a soft red.
            storage.addAttribute_value_range(
                NSForegroundColorAttributeName,
                &NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.42, 0.42, 1.0),
                NSRange::new(0, title_len),
            );
            storage.addAttribute_value_range(
                NSForegroundColorAttributeName,
                &NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 1.0, 0.7),
                NSRange::new(hint_at, units(hint)),
            );
        }
    }
    text.sizeToFit();
    scroll.setDocumentView(Some(&text));
    overlay.addSubview(&scroll);
    add_copy_button(&overlay, format!("{title}\n\n{message}"), mtm);
    container.addSubview(&overlay);
    ui.borrow_mut().error = Some(overlay);
    // The status line stays above the overlay.
    if let Some((pill, _)) = &ui.borrow().status {
        container.addSubview(pill);
    }
}

fn hide_error(ui: &RefCell<DevUi>) {
    if let Some(error) = ui.borrow_mut().error.take() {
        error.removeFromSuperview();
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
