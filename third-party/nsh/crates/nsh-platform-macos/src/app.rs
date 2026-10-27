//! `AppView` (one surface as an AppKit view, for embedding) and the
//! standalone app ([`run_app`]: one `AppView` filling a window).

use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, RwLock},
};

use nsh_core::{
    geometry::{Size, px},
    platform::{Appearance, Locale},
};
use nsh_engine::{App, Bundle, ColorScheme, EngineConfig, Environment, Idiom, Limits, Os, Root};
use objc2::{
    MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
    runtime::ProtocolObject, sel,
};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate,
    NSApplicationTerminateReply, NSAutoresizingMaskOptions, NSBackingStoreType, NSEvent,
    NSEventModifierFlags, NSEventType, NSMenu, NSMenuItem, NSResponder, NSScreen, NSView, NSWindow,
    NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::{
    NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString,
};

use crate::{
    image::{AssetBase, AssetReader},
    surface::Surface,
};

static UI_SETS: RwLock<Option<Vec<nsh_core::element::Registry>>> = RwLock::new(None);

/// Sets the UI sets every engine serves (default: `nsh/base`); an app
/// with Rust components of its own calls this before [`run_app`].
pub fn set_ui_sets(sets: Vec<nsh_core::element::Registry>) {
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

/// The app's Rust root ([`set_root`]).
#[cfg(feature = "dev")]
static ROOT: RwLock<Option<fn() -> Root>> = RwLock::new(None);

/// Sets the root of an app of Rust only (`nsh.json` `"root"`), which this
/// development host runs when its dev server publishes the app as the
/// host's root (`nsh test --target macos` of such an app) instead of a
/// bundle.
#[cfg(feature = "dev")]
pub fn set_root(root: fn() -> Root) {
    *ROOT.write().unwrap_or_else(|e| e.into_inner()) = Some(root);
}

/// The app's Rust root, if the host has one ([`set_root`]).
#[cfg(feature = "dev")]
pub(crate) fn root() -> Option<Root> {
    let root = *ROOT.read().unwrap_or_else(|e| e.into_inner());
    root.map(|root| root())
}

/// The UI sets engines serve.
pub(crate) fn ui_sets() -> Vec<nsh_core::element::Registry> {
    UI_SETS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| vec![nsh_base::registry()])
}

/// What [`run_app`] runs.
#[derive(Debug)]
#[allow(
    clippy::large_enum_variant,
    reason = "one source per view; keep the public constructor API without allocation"
)]
pub enum AppSource {
    /// A Rust app: its root component.
    Rust(Root),
    /// A JS bundle shipped with (or passed to) the app.
    Bundle(Bundle),
    /// A dev server (`ws://host:port/ws`); bundles are pushed on every
    /// rebuild.
    #[cfg(feature = "dev")]
    DevServer(String),
}

/// Options of an [`AppView`] and [`run_app`].
#[derive(Debug, Clone)]
pub struct AppOptions {
    /// Log per-commit timings.
    pub trace: bool,
    /// Where bundled assets are (for [`AppSource::Bundle`]); dev servers
    /// serve them themselves.
    pub asset_base: Option<AssetBase>,
    /// The directory `import()` loads a chunk from: the `.js` files `nsh
    /// build --split` writes (each named after its chunk id), or a
    /// directory the app keeps its own delivered modules in. Chunks load
    /// as source (`Bundle::read`); `None` fails an `import()` the bundle
    /// does not already hold.
    pub chunks: Option<PathBuf>,
    /// The application id (`com.example.app`).
    pub app_id: String,
    /// The window title.
    pub title: String,
    /// The initial window size in points.
    pub size: (i32, i32),
    /// The display [`run_app`]'s window opens on, centered. `None` (the
    /// default), or a display that is not there, centers it where AppKit
    /// centers a new window. `nsh run --display` sets it, and `nsh test
    /// --target macos` (a secondary display, unless `--display` names one),
    /// so a test run's windows keep off the screen in use.
    pub display: Option<WindowDisplay>,
    /// Keeps [`run_app`]'s window at [`size`](Self::size) when it does not
    /// fit on its display: AppKit shrinks a window taller than its screen
    /// when it shows it (`constrainFrameRect:toScreen:`), and the app would
    /// lay out in less room than asked. False by default (AppKit's
    /// behavior); `nsh test --target macos` sets it (the development host's
    /// `--keep-window-size`), so a test's window is the size it opens it at
    /// whichever display it is on.
    pub keep_size: bool,
    /// Hides the standalone window on close while retaining its engine.
    /// Reopening from the Dock shows the same window. Quit still stops the app.
    /// Only used by [`run_app`]; defaults to false.
    pub keep_alive_on_close: bool,
    /// The native components apps can use (`nsh/native`); shared by the
    /// views made with these options. See [`AppView::register_component`].
    pub components: crate::native::Components,
    /// The app's appearance until it sets one (`nsh.json` `"appearance"`,
    /// which the bundle sets again when it starts): known before the
    /// first frame, the window opens in it rather than flashing the
    /// system's.
    pub appearance: Appearance,
    /// Shows the performance monitor over the app (frame rate, frame and
    /// commit costs, CPU, GPU, memory): see [`AppView::set_fps_monitor`].
    pub fps: bool,
    /// The VM limits of the apps it runs: [`Limits::default`] (an app
    /// embedded in a host app) unless set; the development host and the
    /// release runner run apps on their own, with none
    /// ([`Limits::standalone`]). See [`AppView::set_limits`].
    pub limits: Limits,
    /// Where the apps it runs keep their data, each in `<dir>/<app id>`
    /// (`nsh.json` `"id"`, which travels with the bundle): `None` uses the
    /// system's data directory ([`nsh_engine::data_dir`]); an app that
    /// embeds nsh gives its own (its data directory + `/nsh`, say).
    pub data_dir: Option<PathBuf>,
    /// Where the apps it runs keep their caches (the images they
    /// downloaded) and how much each keeps: by default the system's cache
    /// directory, each app's in `<dir>/<app id>`. See [`AppView::set_cache`].
    pub cache: nsh_engine::CacheOptions,
    /// The apps' storage (`nsh/storage`), overriding the `storage.json` in
    /// their directory of [`data_dir`](Self::data_dir).
    pub storage: Option<Arc<dyn nsh_engine::StorageBackend>>,
    /// The embedding app's channel with the apps the view runs
    /// (`nsh/host`): their launch parameters, events to them and handlers of
    /// their calls and posts ([`AppView::host`]). One for every app the view
    /// loads; a new one by default.
    pub host: nsh_engine::HostChannel,
}

impl Default for AppOptions {
    fn default() -> Self {
        AppOptions {
            trace: false,
            asset_base: None,
            chunks: None,
            app_id: "com.longbridge.nsh.host".to_owned(),
            title: "nsh".to_owned(),
            size: (1200, 800),
            display: None,
            keep_size: false,
            keep_alive_on_close: false,
            components: Default::default(),
            appearance: Appearance::System,
            fps: false,
            limits: Limits::default(),
            data_dir: None,
            cache: Default::default(),
            storage: None,
            host: nsh_engine::HostChannel::default(),
        }
    }
}

/// The display a window opens on ([`AppOptions::display`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum WindowDisplay {
    /// The display at this index of the system's list (`NSScreen.screens`;
    /// 0 is the primary display, the one with the menu bar).
    Index(usize),
    /// The first display of the list besides the primary one, that does not
    /// mirror it (shows the same part of the desktop); the primary one when
    /// there is no other.
    Secondary,
}

/// One nsh surface as an AppKit view: an engine running one app.
///
/// ```no_run
/// use nsh_platform_macos::{
///     AppOptions, AppView, AssetBase, Bundle, objc2::MainThreadMarker, objc2_app_kit::NSWindow,
/// };
///
/// fn show(window: &NSWindow) -> std::rc::Rc<AppView> {
///     let mtm = MainThreadMarker::new().expect("main thread");
///     let view = AppView::new(
///         mtm,
///         AppOptions {
///             asset_base: Some(AssetBase::Directory("app/assets".into())),
///             ..AppOptions::default()
///         },
///     );
///     let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
///     view.load(Bundle::source(code).into());
///     window.setContentView(Some(&view.view()));
///     // Keep the view (its engine) while the window shows it; `stop` it
///     // when the window closes.
///     view
/// }
/// ```
pub struct AppView {
    surface: Rc<Surface>,
    /// Hosts the surface and, in development, the status line and error
    /// overlay above it.
    container: Retained<NSView>,
    options: RefCell<AppOptions>,
    /// The performance monitor's HUD, while it shows.
    fps: RefCell<Option<Rc<crate::fps::Hud>>>,
    #[cfg(feature = "dev")]
    pub(crate) dev: RefCell<Option<crate::dev::DevSession>>,
}

impl AppView {
    /// A view with no app yet; it fills its superview.
    pub fn new(mtm: MainThreadMarker, options: AppOptions) -> Rc<AppView> {
        let surface = Surface::new(mtm, initial_environment());
        surface.appearance.set(options.appearance);
        let frame = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(options.size.0 as f64, options.size.1 as f64),
        );
        let container = NSView::initWithFrame(NSView::alloc(mtm), frame);
        container.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        container.setWantsLayer(true);
        let root = surface.root.ns();
        root.setFrame(frame);
        root.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        container.addSubview(root);
        surface.native.set_components(options.components.clone());
        let view = Rc::new(AppView {
            surface,
            container,
            options: RefCell::new(options),
            fps: RefCell::new(None),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        if view.options.borrow().fps {
            view.set_fps_monitor(true);
        }
        view
    }

    /// The view to put in a window.
    pub fn view(&self) -> Retained<NSView> {
        self.container.clone()
    }

    /// The channel with the apps this view runs (`nsh/host`;
    /// [`AppOptions::host`]): set their launch parameters
    /// ([`nsh_engine::HostChannel::set_params`], read when an app starts),
    /// send them events ([`nsh_engine::HostChannel::send`]) and handle their
    /// calls and posts ([`nsh_engine::HostChannel::handle`]; handlers run on
    /// the engine thread). Any thread may use it.
    pub fn host(&self) -> nsh_engine::HostChannel {
        self.options.borrow().host.clone()
    }

    /// The VM limits ([`AppOptions::limits`]) of the apps loaded from now
    /// on: the JS heap, the stack, the time budgets of loading and of every
    /// other call into JS, and the quotas (nodes, ops). The running app
    /// keeps the limits it was loaded with.
    pub fn set_limits(&self, limits: Limits) {
        self.options.borrow_mut().limits = limits;
    }

    /// Where the apps loaded from now on keep their caches (the images they
    /// downloaded) and how much each keeps. The running app keeps the
    /// caches it was loaded with.
    pub fn set_cache(&self, cache: nsh_engine::CacheOptions) {
        self.options.borrow_mut().cache = cache;
    }

    /// Runs `app`, replacing what ran.
    pub fn load(&self, app: App) {
        let options = self.options.borrow();
        let config = EngineConfig {
            app,
            viewport: nsh_core::Size::new(px(0.0), px(0.0)),
            trace: options.trace,
            network: Some(crate::net::network()),
            websocket: None,
            filesystem: None,
            assets: Some(Arc::new(AssetReader(options.asset_base.clone()))),
            environment: self.surface.environment.get(),
            // NSH draws no header: a page's `header` sits at its top.
            header_heights: nsh_core::NO_NATIVE_HEADER,
            limits: options.limits,
            ui_sets: ui_sets(),
            runtime: None,
            data_dir: options.data_dir.clone().or_else(nsh_engine::data_dir),
            cache: options.cache.clone(),
            storage: options.storage.clone(),
            clock: Default::default(),
            context: Default::default(),
            pinned: Default::default(),
            clipboard: None,
            host: options.host.clone(),
            picker: None,
        };
        crate::image::set_asset_base(&self.surface, options.asset_base.clone());
        *self.surface.chunks.borrow_mut() = options.chunks.clone();
        self.surface
            .native
            .set_asset_base(options.asset_base.clone());
        self.surface.native.set_app(&config.app);
        self.surface.start(config);
    }

    /// Where `asset:/` URIs resolve from now on.
    pub fn set_asset_base(&self, base: Option<AssetBase>) {
        self.options.borrow_mut().asset_base = base;
    }

    /// Registers native component `name` (`nativeComponent(name, ...)` in
    /// JS): `factory` makes one for every element. Applies to elements
    /// created from now on.
    pub fn register_component(&self, name: &str, factory: crate::native::ComponentFactory) {
        self.surface.native.components().register(name, factory);
    }

    /// Shows (or hides) the performance monitor: a panel at the top right
    /// with the frame rate, what frames cost the main thread, what commits
    /// cost the engine thread (JS, layout), and the process' CPU, GPU and
    /// memory, also logged once a second (target `nsh::perf`). Measuring
    /// starts with it and stops when it hides; it survives reloads.
    pub fn set_fps_monitor(&self, show: bool) {
        let mut hud = self.fps.borrow_mut();
        match (show, hud.is_some()) {
            (true, false) => *hud = Some(crate::fps::Hud::show(self)),
            (false, true) => *hud = None,
            _ => {}
        }
    }

    /// What the performance monitor measured, while it shows
    /// ([`AppView::set_fps_monitor`]): [`nsh_engine::perf::PerfMonitor::snapshot`]
    /// reads it.
    pub fn perf_monitor(&self) -> Option<Arc<nsh_engine::perf::PerfMonitor>> {
        self.fps.borrow().as_ref().map(|h| h.monitor().clone())
    }

    /// The embedding app's locale, which stands in for the user's: what
    /// `Intl` formats for by default and what `locale()` (`nsh/device`) and
    /// Rust components' `locale()` read, at once and for every app loaded
    /// later. `None` follows the system's again.
    pub fn set_locale(&self, locale: Option<Locale>) {
        let mut host = self.surface.host_environment.get();
        host.locale = locale;
        self.surface.host_environment.set(host);
        crate::system::host_environment_changed(&self.surface);
    }

    /// The embedding app's text size relative to the default (1.0), which
    /// stands in for the user's: every text that allows font scaling (texts,
    /// inputs, the components' labels and alerts) is laid out again
    /// at it, and `fontScale()` reads it, at once and for every app loaded
    /// later. Lengths stay as they are (spacing, sizes, radii, `rem`):
    /// boxes sized by their text grow with it. `None` follows the system's
    /// again.
    pub fn set_font_scale(&self, scale: Option<f32>) {
        let mut host = self.surface.host_environment.get();
        host.font_scale = scale;
        self.surface.host_environment.set(host);
        crate::system::host_environment_changed(&self.surface);
    }

    /// The embedding app's theme overrides: a theme file of shadcn/ui's
    /// (`{ "cssVars": { "theme": { … }, "light": { … }, "dark": { … } } }`,
    /// values as CSS writes them, as `nsh.json`'s `"theme"`), whose tokens
    /// win over the app's of the same names, light and dark, while the
    /// app's others stay (a brand's `primary` and `radius`). Classes naming
    /// them (`bg-primary`) are resolved again at once, and every app loaded
    /// later starts with them. `None` gives the app its own theme back.
    /// Fails, changing nothing, on a file that does not parse.
    pub fn set_theme_overrides(&self, json: Option<&str>) -> Result<(), nsh_base::ThemeError> {
        let tokens = json.map(nsh_base::theme_overrides).transpose()?;
        *self.surface.host_tokens.borrow_mut() = tokens.clone();
        self.surface.control(|c| c.set_tokens(tokens));
        Ok(())
    }

    /// Stops the app.
    pub fn stop(&self) {
        self.surface.stop();
    }

    pub(crate) fn surface(&self) -> &Rc<Surface> {
        &self.surface
    }

    /// The view the surface is in (overlays go above it).
    pub(crate) fn container(&self) -> &NSView {
        &self.container
    }
}

fn initial_environment() -> Environment {
    Environment {
        window: Size::new(px(0.0), px(0.0)),
        color_scheme: ColorScheme::Light,
        os: Os::MacOs,
        idiom: Idiom::Desktop,
        ..Environment::default()
    }
}

/// The standalone app's window and view.
struct Running {
    window: Retained<NSWindow>,
    view: Rc<AppView>,
    keep_alive_on_close: bool,
}

thread_local! {
    static RUNNING: RefCell<Option<Running>> = const { RefCell::new(None) };
}

define_class!(
    /// [`run_app`]'s window when [`AppOptions::keep_size`] is set: AppKit
    /// leaves its frame as it is, the window may be taller or wider than its
    /// screen.
    #[unsafe(super(NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshKeptSizeWindow"]
    struct KeptSizeWindow;

    unsafe impl NSObjectProtocol for KeptSizeWindow {}

    impl KeptSizeWindow {
        #[unsafe(method(constrainFrameRect:toScreen:))]
        fn constrain_frame_rect(&self, rect: NSRect, _screen: Option<&NSScreen>) -> NSRect {
            rect
        }
    }
);

define_class!(
    /// Closes the app with its window.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshAppDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl NSApplicationDelegate for Delegate {
        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn should_terminate_after_last_window_closed(&self, _app: &NSApplication) -> bool {
            false
        }

        #[unsafe(method(applicationShouldTerminate:))]
        fn should_terminate(&self, app: &NSApplication) -> NSApplicationTerminateReply {
            finish_running(app);
            // The caller owns process termination after run_app returns.
            NSApplicationTerminateReply::TerminateCancel
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn should_handle_reopen(&self, _app: &NSApplication, _visible: bool) -> bool {
            let window = RUNNING.with(|running| {
                running
                    .borrow()
                    .as_ref()
                    .map(|running| running.window.clone())
            });
            if let Some(window) = window {
                if window.isMiniaturized() {
                    window.deminiaturize(None);
                }
                window.makeKeyAndOrderFront(None);
            }
            false
        }

        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _notification: &NSNotification) {
            stop_running();
        }
    }

    unsafe impl NSWindowDelegate for Delegate {
        #[unsafe(method(windowShouldClose:))]
        fn should_close(&self, window: &NSWindow) -> bool {
            let keep_alive = RUNNING.with(|running| {
                running
                    .borrow()
                    .as_ref()
                    .is_some_and(|running| running.keep_alive_on_close)
            });
            if keep_alive {
                window.orderOut(None);
            }
            !keep_alive
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            stop_running();
            // Leave AppKit's close callback before stopping its event loop,
            // including when the window closed while minimized.
            dispatch2::DispatchQueue::main().exec_async(|| {
                if let Some(mtm) = MainThreadMarker::new() {
                    finish_running(&NSApplication::sharedApplication(mtm));
                }
            });
        }
    }
);

/// Quits the standalone runner, including a retained hidden window.
/// Stops its engine and returns from [`run_app`]. May be called from any thread;
/// the request is dispatched to AppKit's main thread. With no standalone runner
/// this has no effect; embedded hosts own their application lifecycle.
pub fn quit_app() {
    dispatch2::DispatchQueue::main().exec_async(|| {
        if RUNNING.with(|running| running.borrow().is_some())
            && let Some(mtm) = MainThreadMarker::new()
        {
            finish_running(&NSApplication::sharedApplication(mtm));
        }
    });
}

/// Ends the standalone event loop, returning process ownership to its caller.
fn finish_running(app: &NSApplication) {
    let window = RUNNING.with(|running| {
        running
            .borrow()
            .as_ref()
            .map(|running| running.window.clone())
    });
    if let Some(window) = window {
        // Quit has no window-close callback yet. Close without re-entering
        // this delegate, and keep the window alive until close returns.
        window.setDelegate(None);
        window.close();
    }
    stop_running();
    app.stop(None);
    // stop: takes effect after the next event. A close can arrive through a
    // dispatch block rather than an AppKit event, so wake nextEventMatchingMask
    // explicitly instead of waiting for the user to move the mouse.
    if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::empty(),
        0.0,
        0,
        None,
        0,
        0,
        0,
    ) {
        app.postEvent_atStart(&event, true);
    }
}

/// Stops the standalone app's engine (its window closes).
fn stop_running() {
    if let Some(running) = RUNNING.with(|r| r.borrow_mut().take()) {
        running.view.stop();
        drop(running.window);
    }
}

/// Names the app `name` in the menu bar, which shows the bundle's name
/// as the app menu's title: an executable without a bundle (the
/// development host) would show its file's name. Before the app finishes
/// launching.
fn name_app(name: &str) {
    use objc2::ClassType;
    use objc2_foundation::{NSBundle, NSMutableDictionary};
    let Some(info) = NSBundle::mainBundle().infoDictionary() else {
        return;
    };
    let name = NSString::from_str(name);
    // A bundle's dictionary is mutable in practice; the dictionary of an
    // executable without one too.
    // SAFETY: `isKindOfClass:` takes any class; `setObject:forKey:` is
    // sent only to a mutable dictionary, with a string key and value.
    unsafe {
        let mutable: bool =
            msg_send![&*info, isKindOfClass: NSMutableDictionary::<NSString, NSString>::class()];
        if mutable {
            let _: () = msg_send![&*info, setObject: &*name, forKey: objc2_foundation::ns_string!("CFBundleName")];
        }
    }
}

/// Runs `source` in a window until it is closed. Must be called on the
/// main thread. By default closing the window stops the engine and returns;
/// `keep_alive_on_close` retains the same engine until Quit or [`quit_app`].
/// The caller can finish cleanup or relaunch after this function returns.
pub fn run_app(source: AppSource, options: AppOptions) -> std::process::ExitCode {
    let mtm = MainThreadMarker::new().expect("run_app must be called on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    name_app(&options.title);
    crate::chrome::set_app_name(&options.title);
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(mtm), init] };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    app.setMainMenu(Some(&main_menu(mtm, &options.title)));

    let frame = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(options.size.0 as f64, options.size.1 as f64),
    );
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    let window = if options.keep_size {
        // SAFETY: NSWindow's designated initializer, sent to a subclass
        // that adds no state of its own.
        let window: Retained<KeptSizeWindow> = unsafe {
            msg_send![
                KeptSizeWindow::alloc(mtm),
                initWithContentRect: frame,
                styleMask: style,
                backing: NSBackingStoreType::Buffered,
                defer: false
            ]
        };
        Retained::into_super(window)
    } else {
        // SAFETY: NSWindow's designated initializer.
        unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                style,
                NSBackingStoreType::Buffered,
                false,
            )
        }
    };
    // SAFETY: the window is kept in `RUNNING` until it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&options.title));
    window.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    crate::system::open_window(&window, options.appearance);
    let view = AppView::new(mtm, options.clone());
    window.setContentView(Some(&view.view()));
    window.center();
    if let Some(display) = options.display {
        center_on_display(&window, display);
    }
    match source {
        AppSource::Rust(root) => view.load(App::Rust(root)),
        AppSource::Bundle(bundle) => view.load(App::Js(bundle)),
        #[cfg(feature = "dev")]
        AppSource::DevServer(url) => crate::dev::start(&view, url),
    }
    window.makeKeyAndOrderFront(None);
    window.makeFirstResponder(Some(view.surface().root.ns()));
    app.activate();
    RUNNING.with(|r| {
        *r.borrow_mut() = Some(Running {
            window,
            view,
            keep_alive_on_close: options.keep_alive_on_close,
        })
    });
    app.run();
    stop_running();
    app.setDelegate(None);
    drop(delegate);
    std::process::ExitCode::SUCCESS
}

/// Centers `window` on `display` (its visible part: below the menu bar,
/// beside the Dock), its title bar on it when the window is taller; leaves
/// it where it is when there is no such display.
fn center_on_display(window: &NSWindow, display: WindowDisplay) {
    let screens = NSScreen::screens(MainThreadMarker::from(window));
    let index = match display {
        WindowDisplay::Index(index) => index,
        WindowDisplay::Secondary => {
            let frames: Vec<NSRect> = screens.iter().map(|s| s.frame()).collect();
            match secondary(&frames) {
                Some(index) => index,
                None => return,
            }
        }
    };
    if index >= screens.count() {
        log::warn!(
            "there is no display {} ({} connected): the window opens on the main one",
            index + 1,
            screens.count()
        );
        return;
    }
    let area = screens.objectAtIndex(index).visibleFrame();
    let size = window.frame().size;
    let x = area.origin.x + ((area.size.width - size.width) / 2.0).max(0.0);
    // From the bottom: a window taller than the area keeps its top (the
    // title bar) inside it, as AppKit keeps it when it shows the window.
    let y = area.origin.y + area.size.height - size.height;
    let y = y - ((area.size.height - size.height) / 2.0).max(0.0);
    window.setFrameOrigin(NSPoint::new(x, y));
}

/// The first of the displays (their frames, the primary display's first)
/// besides the primary one that does not mirror it: a mirror shows the
/// same part of the desktop, so its frame is the primary's.
fn secondary(frames: &[NSRect]) -> Option<usize> {
    let primary = frames.first()?;
    frames.iter().position(|f| f != primary)
}

/// The app menu (About, Hide, Quit), Edit (the text commands fields
/// answer: undo, cut, copy, paste, select all) and Window (minimize, zoom,
/// full screen, close).
fn main_menu(mtm: MainThreadMarker, title: &str) -> Retained<NSMenu> {
    let bar = NSMenu::new(mtm);
    let item = |menu: &NSMenu, title: &str, action: Option<objc2::runtime::Sel>, key: &str| {
        // SAFETY: the actions are AppKit's standard ones, sent down the
        // responder chain.
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        };
        menu.addItem(&item);
        item
    };
    let submenu = |name: &str| {
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(name));
        let holder = item(&bar, name, None, "");
        holder.setSubmenu(Some(&menu));
        menu
    };
    let app_menu = submenu(title);
    item(
        &app_menu,
        &format!("About {title}"),
        Some(sel!(orderFrontStandardAboutPanel:)),
        "",
    );
    app_menu.addItem(&NSMenuItem::separatorItem(mtm));
    item(&app_menu, &format!("Hide {title}"), Some(sel!(hide:)), "h");
    let others = item(
        &app_menu,
        "Hide Others",
        Some(sel!(hideOtherApplications:)),
        "h",
    );
    others
        .setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Option);
    app_menu.addItem(&NSMenuItem::separatorItem(mtm));
    item(
        &app_menu,
        &format!("Quit {title}"),
        Some(sel!(terminate:)),
        "q",
    );

    let edit = submenu("Edit");
    item(&edit, "Undo", Some(sel!(undo:)), "z");
    // An uppercase key equivalent is Shift with it.
    item(&edit, "Redo", Some(sel!(redo:)), "Z");
    edit.addItem(&NSMenuItem::separatorItem(mtm));
    item(&edit, "Cut", Some(sel!(cut:)), "x");
    item(&edit, "Copy", Some(sel!(copy:)), "c");
    item(&edit, "Paste", Some(sel!(paste:)), "v");
    item(&edit, "Select All", Some(sel!(selectAll:)), "a");

    let window = submenu("Window");
    item(&window, "Minimize", Some(sel!(performMiniaturize:)), "m");
    item(&window, "Zoom", Some(sel!(performZoom:)), "");
    let full = item(
        &window,
        "Enter Full Screen",
        Some(sel!(toggleFullScreen:)),
        "f",
    );
    full.setKeyEquivalentModifierMask(
        NSEventModifierFlags::Command | NSEventModifierFlags::Control,
    );
    window.addItem(&NSMenuItem::separatorItem(mtm));
    item(&window, "Close", Some(sel!(performClose:)), "w");
    bar
}

#[cfg(test)]
mod tests {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    use super::secondary;

    fn frame(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }

    /// A secondary display is the first that is not the primary one or a
    /// mirror of it; one display alone has none.
    #[test]
    fn the_secondary_display_skips_the_primary_and_its_mirrors() {
        let primary = frame(0.0, 0.0, 3008.0, 1692.0);
        let built_in = frame(3008.0, 0.0, 1800.0, 1169.0);
        assert_eq!(secondary(&[primary]), None);
        assert_eq!(secondary(&[]), None);
        assert_eq!(secondary(&[primary, built_in]), Some(1));
        assert_eq!(secondary(&[primary, primary, built_in]), Some(2));
        assert_eq!(secondary(&[primary, primary]), None);
    }
}
