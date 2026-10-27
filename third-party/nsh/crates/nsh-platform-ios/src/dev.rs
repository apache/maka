//! Development host support: connects to the `nsh` dev server, loads every
//! pushed bundle, forwards logs to the developer's terminal and shows build
//! and runtime errors on screen.

use std::{
    cell::RefCell,
    io::Write,
    rc::Rc,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_dev::{
    DevClient, DevEvent, HostInfo,
    protocol::{BundleFormat, HostPlatform},
};
use nsh_engine::{App, BYTECODE_VERSION, Bundle, Limits, Policy};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_foundation::{NSMutableAttributedString, NSObject, NSRange, NSString};
use objc2_ui_kit::{
    NSFontAttributeName, NSForegroundColorAttributeName, NSTextAlignment, UIColor, UIDevice,
    UIEdgeInsets, UIFont, UIFontWeightRegular, UIFontWeightSemibold, UILabel,
    UITapGestureRecognizer, UITextView, UIView, UIViewAutoresizing,
};

use crate::view::Inner;

/// The client of the most recent session: logs go there.
static CLIENT: Mutex<Weak<DevClient>> = Mutex::new(Weak::new());
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

/// Names the sessions' views to their test agents.
static NEXT_KEY: AtomicU64 = AtomicU64::new(1);

/// A connection to a dev server, loading its bundles into one view.
pub(crate) struct DevSession {
    /// Keeps the client (and its thread) alive.
    _client: Arc<DevClient>,
    ui: Rc<RefCell<DevUi>>,
}

impl DevSession {
    /// Connects; bundles go to `view` for as long as it exists.
    pub(crate) fn start(view: std::rc::Weak<Inner>, url: String) -> Option<DevSession> {
        let container = view.upgrade()?.container.clone();
        let mtm = container.mtm();
        let ui = Rc::new(RefCell::new(DevUi::default()));
        show_status(&ui, &container, &format!("Connecting to {url}…"));
        // A test session (`nsh test --target ios`): the view keeps the
        // model the agent's steps see, from the first bundle on (the main
        // queue is serial, so it comes before the bundle).
        let key = NEXT_KEY.fetch_add(1, Ordering::Relaxed);
        crate::agent::register(key, view.clone());
        let tested = Arc::new(MainThreadBound::new(view.clone(), mtm));
        let tester = nsh_testing::agent::Tester::new(move |model| {
            let tested = tested.clone();
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(view) = tested.get(mtm).upgrade() {
                    view.set_test_model(model);
                }
            });
            Box::new(crate::agent::IosNative::new(key))
        });
        let tests = tester.clone();
        let target = MainThreadBound::new((view, ui.clone()), mtm);
        let target = Arc::new(target);
        let host = HostInfo {
            device: device_name(mtm),
            platform: if cfg!(target_abi = "macabi") {
                HostPlatform::MacCatalyst
            } else if cfg!(target_abi = "sim") {
                HostPlatform::IosSimulator
            } else {
                HostPlatform::Ios
            },
            bytecode_version: BYTECODE_VERSION.to_owned(),
            ui_sets: crate::ui_sets()
                .iter()
                .flat_map(nsh_core::element::Registry::sets)
                .filter_map(|set| set.specifier().map(str::to_owned))
                .collect(),
            tests: true,
        };
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
            let target = target.clone();
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                let (view, ui) = target.get(mtm);
                if let Some(view) = view.upgrade() {
                    handle(&view, ui, event);
                }
            });
        });
        match started {
            Ok(client) => {
                let client = Arc::new(client);
                tester.set_client(&client);
                *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(&client);
                Some(DevSession {
                    _client: client,
                    ui,
                })
            }
            Err(err) => {
                log::error!("cannot start the dev client: {err}");
                None
            }
        }
    }

    pub(crate) fn show_error(&self, container: &UIView, title: &str, message: &str) {
        show_error(&self.ui, container, title, message, false);
    }

    /// A hot update failed: loads the latest bundle from scratch.
    pub(crate) fn reload(view: &Rc<Inner>) {
        let latest = view
            .dev()
            .as_ref()
            .and_then(|d| d.ui.borrow().latest.clone());
        if let Some(bundle) = latest {
            log::info!("reloading after an update that could not be applied in place");
            Inner::load(view, bundle.into());
        }
    }
}

#[derive(Default)]
struct DevUi {
    /// Build the app runs (loaded, or reached by hot updates): the server
    /// run it came from and its number.
    running: Option<(u64, u64)>,
    /// The latest bundle, for reloads.
    latest: Option<Bundle>,
    status: Option<Retained<UILabel>>,
    overlay: Option<Retained<UIView>>,
    target: Option<Retained<DismissTarget>>,
    /// The overlay's Copy button and the text it copies.
    copy: Option<(Retained<UILabel>, String)>,
}

define_class!(
    /// Handles taps on the error overlay: one on its Copy button copies the
    /// error, any other dismisses it.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = std::rc::Weak<RefCell<DevUi>>]
    struct DismissTarget;

    impl DismissTarget {
        #[unsafe(method(dismiss:))]
        fn dismiss(&self, sender: &UITapGestureRecognizer) {
            let Some(ui) = self.ivars().upgrade() else { return };
            if let Some((button, text)) = &ui.borrow().copy {
                let at = sender.locationInView(Some(button));
                let size = button.bounds().size;
                if (0.0..=size.width).contains(&at.x) && (0.0..=size.height).contains(&at.y) {
                    crate::system::set_clipboard(text);
                    button.setText(Some(&NSString::from_str("Copied")));
                    return;
                }
            }
            hide_error(&ui);
        }
    }
);

impl DismissTarget {
    fn new(mtm: MainThreadMarker, ui: std::rc::Weak<RefCell<DevUi>>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ui);
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

fn device_name(mtm: MainThreadMarker) -> String {
    if cfg!(target_abi = "macabi") {
        // UIDevice reports "iPad" under Catalyst.
        "Mac Catalyst".to_owned()
    } else if cfg!(target_abi = "sim") {
        format!("iOS Simulator ({})", UIDevice::currentDevice(mtm).name())
    } else {
        UIDevice::currentDevice(mtm).name().to_string()
    }
}

fn handle(view: &Rc<Inner>, ui: &Rc<RefCell<DevUi>>, event: DevEvent) {
    let container = &view.container;
    match event {
        DevEvent::Connected => hide_status(ui),
        DevEvent::Disconnected => {
            show_status(ui, container, "Dev server disconnected — reconnecting…")
        }
        // The client's thread hands them to the test agent.
        DevEvent::Testing
        | DevEvent::Step { .. }
        | DevEvent::TestSetup { .. }
        | DevEvent::Fetch { .. } => {}
        DevEvent::Root => {
            hide_status(ui);
            let Some(root) = crate::root() else {
                return show_error(
                    ui,
                    container,
                    "This host cannot run the app",
                    "The app is of Rust only, and this host was not built with its root.",
                    true,
                );
            };
            {
                let mut ui = ui.borrow_mut();
                ui.latest = None;
                ui.running = None;
            }
            hide_error(ui);
            Inner::load(view, App::Rust(root));
        }
        DevEvent::Building => {}
        DevEvent::BuildFailed(message) => {
            show_error(ui, container, "Build failed", &message, false)
        }
        DevEvent::CannotRun { message, .. } => {
            hide_status(ui);
            show_error(
                ui,
                container,
                "This host cannot run the app",
                &message,
                true,
            )
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
            let mut bundle = match format {
                // SAFETY: compiled for this runtime's bytecode version (the
                // handshake) by the dev server the developer connected to.
                BundleFormat::Bytecode => {
                    unsafe { Bundle::bytecode(bytes) }.with_policy(Policy::development())
                }
                BundleFormat::Source => match String::from_utf8(bytes) {
                    Ok(code) => Bundle::source(code).with_policy(Policy::development()),
                    Err(_) => {
                        return show_error(
                            ui,
                            container,
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
            bundle = bundle.with_app_id(app_id.as_deref());
            bundle = match bundle.with_capabilities_json(capabilities.as_deref()) {
                Ok(bundle) => bundle,
                Err(err) => return show_error(ui, container, "Invalid capabilities", &err, true),
            };
            let limits = match Limits::development(limits.as_deref()) {
                Ok(limits) => limits,
                Err(err) => return show_error(ui, container, "Invalid limits", &err, true),
            };
            hide_status(ui);
            let running = {
                let mut ui = ui.borrow_mut();
                ui.latest = Some(bundle.clone());
                ui.running.replace((session, version))
            };
            // Already there through a hot update.
            if running == Some((session, version)) {
                return;
            }
            log::info!("loading build {version}");
            hide_error(ui);
            view.set_limits(limits);
            Inner::load(view, bundle.into());
        }
        DevEvent::Patch {
            session,
            version,
            base,
            code,
            source_map,
        } => {
            if ui.borrow().running != Some((session, base)) {
                return;
            }
            let update = nsh_engine::HotUpdate {
                name: format!("hot-{version}.js"),
                code,
                source_map: source_map.map(Into::into),
            };
            if view.hot_update(update) {
                log::info!("updating to build {version}");
                ui.borrow_mut().running = Some((session, version));
                hide_error(ui);
            }
        }
    }
}

fn show_status(ui: &RefCell<DevUi>, container: &UIView, text: &str) {
    let mtm = container.mtm();
    {
        let mut ui = ui.borrow_mut();
        let label = ui.status.get_or_insert_with(|| {
            let label = UILabel::new(mtm);
            label.setTextAlignment(NSTextAlignment::Center);
            // SAFETY: non-null values for null-resettable properties, and an
            // immutable UIKit font weight constant.
            unsafe {
                label.setTextColor(Some(&UIColor::whiteColor()));
                label.setFont(Some(&UIFont::systemFontOfSize_weight(
                    13.0,
                    UIFontWeightSemibold,
                )));
            }
            label.setBackgroundColor(Some(&UIColor::colorWithRed_green_blue_alpha(
                0.1, 0.1, 0.1, 0.85,
            )));
            label.setTranslatesAutoresizingMaskIntoConstraints(false);
            label
        });
        label.setText(Some(&NSString::from_str(text)));
        if label.superview().is_none() {
            container.addSubview(label);
            // Below the status bar / notch / Catalyst title bar.
            let guide = container.safeAreaLayoutGuide();
            for constraint in [
                label
                    .topAnchor()
                    .constraintEqualToAnchor(&guide.topAnchor()),
                label
                    .leadingAnchor()
                    .constraintEqualToAnchor(&container.leadingAnchor()),
                label
                    .trailingAnchor()
                    .constraintEqualToAnchor(&container.trailingAnchor()),
                label.heightAnchor().constraintEqualToConstant(32.0),
            ] {
                constraint.setActive(true);
            }
        } else {
            container.bringSubviewToFront(label);
        }
    }
}

fn hide_status(ui: &RefCell<DevUi>) {
    if let Some(label) = ui.borrow_mut().status.take() {
        label.removeFromSuperview();
    }
}

/// Shows a full-screen error over the app; tap to dismiss. `prose` wraps
/// the message to the screen; otherwise its lines are kept (code frames,
/// stack traces) and it scrolls sideways.
fn show_error(
    ui: &Rc<RefCell<DevUi>>,
    container: &UIView,
    title: &str,
    message: &str,
    prose: bool,
) {
    let mtm = container.mtm();
    hide_error(ui);
    let overlay = UIView::initWithFrame(UIView::alloc(mtm), container.bounds());
    overlay.setAutoresizingMask(
        UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
    );
    overlay.setBackgroundColor(Some(&UIColor::colorWithRed_green_blue_alpha(
        0.118, 0.122, 0.133, 0.98,
    )));

    let text = UITextView::new(mtm);
    text.setFrame(overlay.bounds());
    text.setAutoresizingMask(
        UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
    );
    text.setEditable(false);
    text.setBackgroundColor(Some(&UIColor::clearColor()));
    text.setTextColor(Some(&UIColor::whiteColor()));
    // SAFETY: reading an immutable UIKit constant.
    text.setFont(Some(&UIFont::monospacedSystemFontOfSize_weight(
        12.0,
        unsafe { UIFontWeightRegular },
    )));
    // Clear of the status bar / notch / title bar.
    let safe = container.safeAreaInsets();
    text.setTextContainerInset(UIEdgeInsets {
        top: safe.top + 16.0,
        left: safe.left + 16.0,
        bottom: safe.bottom + 24.0,
        right: safe.right + 16.0,
    });
    text.setAttributedText(Some(&error_text(title, message)));
    if !prose {
        // Keep code frames intact: no wrapping, scroll sideways instead.
        let container_text = text.textContainer();
        container_text.setWidthTracksTextView(false);
        container_text.setSize(CGSize::new(4000.0, CGFloat::MAX));
    }
    overlay.addSubview(&text);
    let copy = copy_button(mtm, &overlay, safe);

    {
        let target = DismissTarget::new(mtm, std::rc::Rc::downgrade(ui));
        let mut ui = ui.borrow_mut();
        // SAFETY: `dismiss:` is implemented by `DismissTarget`, kept alive in `UI`.
        let tap = unsafe {
            UITapGestureRecognizer::initWithTarget_action(
                UITapGestureRecognizer::alloc(mtm),
                Some(&target),
                Some(sel!(dismiss:)),
            )
        };
        overlay.addGestureRecognizer(&tap);
        container.addSubview(&overlay);
        ui.overlay = Some(overlay);
        ui.target = Some(target);
        ui.copy = Some((copy, format!("{title}\n\n{message}")));
    }
}

/// The overlay's text: the title alone in a soft red (it says it is an
/// error), the rest white.
fn error_text(title: &str, message: &str) -> Retained<NSMutableAttributedString> {
    let all = format!("{title}\n\n{message}\n\n(tap to dismiss)");
    let text = NSMutableAttributedString::from_nsstring(&NSString::from_str(&all));
    let units = |s: &str| s.encode_utf16().count();
    // SAFETY: UIKit's attribute name and font weight constants; attribute
    // values of the types those names take.
    unsafe {
        let font = UIFont::monospacedSystemFontOfSize_weight(12.0, UIFontWeightRegular);
        text.addAttribute_value_range(NSFontAttributeName, &font, NSRange::new(0, units(&all)));
        text.addAttribute_value_range(
            NSForegroundColorAttributeName,
            &UIColor::whiteColor(),
            NSRange::new(0, units(&all)),
        );
        text.addAttribute_value_range(
            NSForegroundColorAttributeName,
            &UIColor::colorWithRed_green_blue_alpha(1.0, 0.42, 0.42, 1.0),
            NSRange::new(0, units(title)),
        );
    }
    text
}

/// The error overlay's Copy button, in its top right corner (clear of the
/// safe area). The overlay's tap handler copies when a tap lands on it.
fn copy_button(mtm: MainThreadMarker, overlay: &UIView, safe: UIEdgeInsets) -> Retained<UILabel> {
    let label = UILabel::new(mtm);
    label.setTextAlignment(NSTextAlignment::Center);
    label.setText(Some(&NSString::from_str("Copy")));
    // SAFETY: non-null values for null-resettable properties, and an
    // immutable UIKit font weight constant.
    unsafe {
        label.setTextColor(Some(&UIColor::whiteColor()));
        label.setFont(Some(&UIFont::systemFontOfSize_weight(
            13.0,
            UIFontWeightSemibold,
        )));
    }
    label.setBackgroundColor(Some(&UIColor::colorWithRed_green_blue_alpha(
        1.0, 1.0, 1.0, 0.18,
    )));
    let layer = label.layer();
    layer.setCornerRadius(6.0);
    layer.setMasksToBounds(true);
    let (width, height) = (76.0, 30.0);
    label.setFrame(CGRect::new(
        CGPoint::new(
            overlay.bounds().size.width - safe.right - 16.0 - width,
            safe.top + 12.0,
        ),
        CGSize::new(width, height),
    ));
    label.setAutoresizingMask(
        UIViewAutoresizing::FlexibleLeftMargin | UIViewAutoresizing::FlexibleBottomMargin,
    );
    overlay.addSubview(&label);
    label
}

fn hide_error(ui: &RefCell<DevUi>) {
    if let Some(overlay) = ui.borrow_mut().overlay.take() {
        overlay.removeFromSuperview();
    }
}
