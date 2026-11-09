//! `AppView` (one surface as an AppKit view, for embedding) and the
//! standalone app ([`run_app`]: one `AppView` filling a window).

use std::{
    cell::{Cell, RefCell},
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
    MainThreadMarker, MainThreadOnly, class, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    sel,
};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate,
    NSApplicationTerminateReply, NSAutoresizingMaskOptions, NSEvent, NSEventModifierFlags,
    NSEventType, NSMenu, NSMenuItem, NSScreen, NSView, NSWindow, NSWindowDelegate,
    NSWindowStyleMask,
};
use objc2_foundation::{
    NSArray, NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
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

/// The app's native components ([`set_components`]). Process-wide, as the
/// UI sets of [`set_ui_sets`] are: only the hosts and runners nsh generates
/// for an app's crate set it, so in an embedding app it stays `None` and
/// each registry holds only what was registered on its own view.
static COMPONENTS: RwLock<Option<fn(&crate::native::Components)>> = RwLock::new(None);

/// Sets what registers the app's own native components (`nsh.json`
/// `"rust"`, `#[native_components(macos)]`): every [`AppView`] calls it on
/// its [`AppOptions::components`] when it is made, so the app's elements
/// find them as an embedding app's. It runs before the code holding the
/// view can register: a name registered on the view afterwards
/// ([`AppView::register_component`]) replaces the crate's. The development
/// host and release runner nsh generates for such an app call this before
/// [`run_app`].
pub fn set_components(register: fn(&crate::native::Components)) {
    *COMPONENTS.write().unwrap_or_else(|e| e.into_inner()) = Some(register);
}

/// Registers the app's native components ([`set_components`]) on
/// `components`.
fn register_app_components(components: &crate::native::Components) {
    let register = *COMPONENTS.read().unwrap_or_else(|e| e.into_inner());
    if let Some(register) = register {
        register(components);
    }
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
    /// Runs [`run_app`]'s app in the background: it never becomes the
    /// active app (`NSApplicationActivationPolicyProhibited`), so its
    /// window shows without taking the keyboard from the app in use, and it
    /// has no Dock icon or menu bar. False by default; `nsh test --target
    /// macos` sets it (the development host's `--background`) unless told
    /// `--foreground`: the test agent's input goes to the window directly.
    pub background: bool,
    /// Hides the standalone window on close while retaining its engine.
    /// Reopening from the Dock shows the same window. Quit still stops the app.
    /// Only used by [`run_app`]; defaults to false. For releasing the UI on
    /// close and rebuilding it on Open, use [`run_resident_app_with_config`].
    pub keep_alive_on_close: bool,
    /// The smallest size [`run_app`]'s window takes, in points. `None` (the
    /// default) leaves it to AppKit.
    pub min_size: Option<(i32, i32)>,
    /// The name [`run_app`]'s window keeps its frame under in the user's
    /// defaults: it opens where the window with this name last was (AppKit
    /// keeps it on a connected display) and keeps it up to date. `None` (the
    /// default) centers it every time.
    pub frame_autosave_name: Option<String>,
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
    /// The app this view runs owns the process's notifications: banners
    /// show while it is in front, presses come to it and the Dock's badge is
    /// its (`nsh`'s `Notifications`). An embedding app that has a
    /// notification center delegate of its own keeps it. Without it the
    /// permission is `unavailable` and nothing shows. [`run_app`] sets it.
    pub notifications: bool,
    /// The embedding app's channel with the apps the view runs
    /// (`nsh/host`): their launch parameters, events to them and handlers of
    /// their calls and posts ([`AppView::host`]). One for every app the view
    /// loads; a new one by default.
    pub host: nsh_engine::HostChannel,
    /// A see-through window: [`run_app`] opens its window nonopaque with a
    /// clear background, and the surface draws no background under the app's
    /// root, so what the app leaves unpainted shows what is behind the
    /// window (desktop widgets, panels with rounded or irregular outlines,
    /// a `macos={{ backdrop }}` material blending behind the window). False
    /// by default.
    ///
    /// A custom host's initial default: explicit main-window attributes
    /// and later `WindowHandle::set` calls take precedence. Standard hosts
    /// leave this false but can request transparency through their window
    /// configuration. A view's `behindWindow` material never enables it.
    ///
    /// An embedded [`AppView`] draws no background over its host's content
    /// too, but never changes the host's window: the embedding app makes its
    /// window nonopaque and clear itself where it wants that.
    pub transparent: bool,
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
            background: false,
            keep_alive_on_close: false,
            min_size: None,
            frame_autosave_name: None,
            components: Default::default(),
            appearance: Appearance::System,
            fps: false,
            limits: Limits::default(),
            data_dir: None,
            cache: Default::default(),
            storage: None,
            notifications: false,
            host: nsh_engine::HostChannel::default(),
            transparent: false,
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
        surface.transparent.set(options.transparent);
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
        register_app_components(&options.components);
        surface.native.set_components(options.components.clone());
        if options.notifications {
            crate::notifications::enable();
        }
        let view = Rc::new(AppView {
            surface,
            container,
            options: RefCell::new(options),
            fps: RefCell::new(None),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        let weak = Rc::downgrade(&view);
        *view.surface.perf_toggle.borrow_mut() = Some(Box::new(move |show| {
            if let Some(view) = weak.upgrade() {
                view.set_fps_monitor(show);
            }
        }));
        if view.options.borrow().fps || nsh_engine::perf::enabled_by_env() {
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
            refuse_connections: None,
            filesystem: None,
            assets: Some(Arc::new(AssetReader(options.asset_base.clone()))),
            chunk_loader: None,
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
            speech: None,
            audio: None,
            // The app's windows of its own are this backend's.
            windows: None,
        };
        crate::image::set_asset_base(&self.surface, options.asset_base.clone());
        *self.surface.image_assets.borrow_mut() = crate::image::AssetSource::Base;
        *self.surface.chunks.borrow_mut() = options.chunks.clone();
        self.surface
            .native
            .set_asset_base(options.asset_base.clone());
        self.surface
            .native
            .set_app(&config.app, config.data_dir.as_deref());
        self.surface.start(config);
    }

    /// Runs an engine the embedding app configured, replacing what ran. The
    /// surface supplies its viewport and environment; the rest of `config` is
    /// kept. Its asset reader serves both the engine's resources and image
    /// `asset:/` URIs (`None` makes those unavailable), bound to this load
    /// whatever [`Self::set_asset_base`] says.
    pub fn load_with_config(&self, config: EngineConfig) {
        *self.surface.image_assets.borrow_mut() =
            crate::image::AssetSource::engine(config.assets.clone());
        self.surface
            .native
            .set_app(&config.app, config.data_dir.as_deref());
        self.surface.start(config);
    }

    /// Asks the user for one folder, in a sheet of the view's window: `done`
    /// gets its path on the main thread, or `None` when cancelled.
    pub fn choose_directory(&self, done: impl FnOnce(Option<PathBuf>) + 'static) {
        crate::file_requests::choose_directory(&self.surface, done);
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
        screen_color: true,
        file_requests: true,
        native_focus_scopes: true,
        fallback_key_bindings: true,
        speech: true,
        notifications: true,
        audio: true,
        web_input: true,
        ..Environment::default()
    }
}

/// The standalone app's window and view.
struct Running {
    window: Retained<NSWindow>,
    view: Rc<AppView>,
    keep_alive_on_close: bool,
    on_active: Rc<dyn Fn(bool)>,
}

/// Process lifetime state for the opt-in resident runner, without a UI engine.
struct Resident {
    options: AppOptions,
    status_menu: crate::StatusMenuOptions,
    configure: RefCell<Box<dyn FnMut() -> EngineConfig>>,
    on_active: Rc<dyn Fn(bool)>,
    on_close: Box<dyn Fn()>,
    should_close: Box<dyn Fn() -> bool>,
}

thread_local! {
    static RESIDENT: RefCell<Option<Rc<Resident>>> = const { RefCell::new(None) };
    static RUNNING: RefCell<Option<Running>> = const { RefCell::new(None) };
    /// Links that came before the app's engine started.
    static URL_SCHEMES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// The app asked to start again when its run ends
    /// ([`DesktopCommand::Restart`](nsh_core::desktop::DesktopCommand)).
    static RESTART: Cell<bool> = const { Cell::new(false) };
}

/// Hands `url`, a link the system opened the app with, to the running
/// app's engine, whose core keeps it until the app listens; keeps it until
/// the engine starts.
fn url_scheme(url: String) {
    let mut url = Some(url);
    RUNNING.with(|running| {
        if let Some(running) = running.borrow().as_ref() {
            running.view.surface().control(|control| {
                if let Some(url) = url.take() {
                    control.dispatch_event(
                        nsh_core::ROOT_ID,
                        nsh_core::EventKind::UrlScheme,
                        nsh_core::EventPayload::Map(vec![(
                            nsh_core::url_scheme::URL,
                            nsh_core::PayloadValue::Str(url),
                        )]),
                    );
                }
            });
        }
    });
    if let Some(url) = url {
        URL_SCHEMES.with(|links| links.borrow_mut().push(url));
    }
}

define_class!(
    /// Application and standalone window lifecycle callbacks.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshAppDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    impl Delegate {
        /// The quit Apple Event of a logout, restart, shutdown or the Dock.
        /// AppKit's own handler asks `applicationShouldTerminate:`, whose
        /// cancel would veto a logout; this one ends the loop and lets the
        /// event succeed.
        #[unsafe(method(handleQuitEvent:withReplyEvent:))]
        fn handle_quit_event(&self, _event: &AnyObject, _reply: &AnyObject) {
            finish_running(&NSApplication::sharedApplication(MainThreadMarker::from(self)));
        }
    }

    unsafe impl NSApplicationDelegate for Delegate {
        // AppKit installs its own quit handler as it launches, and notifications
        // must be enabled before launching finishes or a press that starts the
        // app is lost.
        #[unsafe(method(applicationWillFinishLaunching:))]
        fn will_finish_launching(&self, _notification: &NSNotification) {
            handle_quit_events(Some(self));
            crate::notifications::enable();
        }

        // The links of the schemes the app claims (`CFBundleURLTypes`), the
        // one that launched it included.
        #[unsafe(method(application:openURLs:))]
        fn open_urls(&self, app: &NSApplication, urls: &NSArray<NSURL>) {
            for url in urls.iter() {
                if let Some(url) = url.absoluteString() {
                    url_scheme(url.to_string());
                }
            }
            // A link opened while the app runs brings it forward.
            app.activate();
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
        }

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
            reopen_window(self);
            false
        }

        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _notification: &NSNotification) {
            stop_running();
        }
    }

    unsafe impl NSWindowDelegate for Delegate {
        #[unsafe(method(windowDidBecomeKey:))]
        fn window_did_become_key(&self, _notification: &NSNotification) {
            window_active(true);
        }

        #[unsafe(method(windowDidResignKey:))]
        fn window_did_resign_key(&self, _notification: &NSNotification) {
            window_active(false);
        }

        // The user's close press: the app's `closeOnPress` says whether it
        // closes ([`crate::window`]), which closes it later.
        #[unsafe(method(windowShouldClose:))]
        fn should_close(&self, window: &NSWindow) -> bool {
            let resident = RESIDENT.with(|resident| resident.borrow().clone());
            if let Some(resident) = resident
                && !(resident.should_close)()
            {
                return false.into();
            }
            let surface = RUNNING.with(|running| {
                running
                    .borrow()
                    .as_ref()
                    .filter(|running| &*running.window == window)
                    .map(|running| running.view.surface().clone())
            });
            match surface {
                Some(surface) => crate::window::main_should_close(&surface, window),
                None => true,
            }
        }

        #[unsafe(method(windowWillClose:))]
        fn window_will_close(&self, _notification: &NSNotification) {
            stop_running();
            if RESIDENT.with(|resident| resident.borrow().is_some()) {
                return;
            }
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

/// Hands the quit Apple Event to `delegate`; `None` removes the handler.
fn handle_quit_events(delegate: Option<&Delegate>) {
    // `kCoreEventClass` and `kAEQuitApplication`.
    const CLASS: u32 = u32::from_be_bytes(*b"aevt");
    const QUIT: u32 = u32::from_be_bytes(*b"quit");
    // SAFETY: the shared manager does not retain its handler; run_window
    // removes the delegate before dropping it.
    unsafe {
        let events: *mut AnyObject =
            msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        match delegate {
            Some(delegate) => {
                let _: () = msg_send![
                    events,
                    setEventHandler: delegate,
                    andSelector: sel!(handleQuitEvent:withReplyEvent:),
                    forEventClass: CLASS,
                    andEventID: QUIT
                ];
            }
            None => {
                let _: () =
                    msg_send![events, removeEventHandlerForEventClass: CLASS, andEventID: QUIT];
            }
        }
    }
}

/// Tells [`run_app_with_config`]'s caller whether the window has the keyboard.
fn window_active(active: bool) {
    RUNNING.with(|running| {
        if let Some(running) = &*running.borrow() {
            if !active {
                crate::text_input::disarm(&running.view.surface);
            }
            (running.on_active)(active);
        }
    });
}

/// Runs `f` with the standalone runner's view on AppKit's main thread. May be
/// called from any thread; with no standalone runner `f` does not run.
pub fn with_running_view(f: impl FnOnce(&AppView) + Send + 'static) {
    dispatch2::DispatchQueue::main().exec_async(move || {
        let view = RUNNING.with(|running| running.borrow().as_ref().map(|r| r.view.clone()));
        if let Some(view) = view {
            f(&view);
        }
    });
}

/// Closes the standalone app's main window (surface `key`'s) without
/// asking the app again: hidden with [`AppOptions::keep_alive_on_close`],
/// else closed, which ends the app. Whether the surface is that window's.
pub(crate) fn close_main_window(key: u64) -> bool {
    let target = RUNNING.with(|running| {
        running
            .borrow()
            .as_ref()
            .filter(|running| running.view.surface().key() == key)
            .map(|running| (running.window.clone(), running.keep_alive_on_close))
    });
    let Some((window, keep_alive)) = target else {
        return false;
    };
    if keep_alive {
        window.orderOut(None);
    } else {
        window.close();
    }
    true
}

/// Quits the standalone runner, including a retained hidden window.
/// Stops its engine and returns from [`run_app`]. May be called from any thread;
/// the request is dispatched to AppKit's main thread. With no standalone runner
/// this has no effect; embedded hosts own their application lifecycle.
pub fn quit_app() {
    dispatch2::DispatchQueue::main().exec_async(|| {
        if (RUNNING.with(|running| running.borrow().is_some())
            || RESIDENT.with(|resident| resident.borrow().is_some()))
            && let Some(mtm) = MainThreadMarker::new()
        {
            finish_running(&NSApplication::sharedApplication(mtm));
        }
    });
}

/// Quits the standalone runner as [`quit_app`] does, and starts the app
/// again once this process has exited ([`nsh_core::restart`]). With no
/// standalone runner this has no effect.
pub(crate) fn restart_app() {
    dispatch2::DispatchQueue::main().exec_async(|| {
        if RUNNING.with(|running| running.borrow().is_some())
            && let Some(mtm) = MainThreadMarker::new()
        {
            RESTART.set(true);
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
    RESIDENT.with(|resident| resident.borrow_mut().take());
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
        (running.on_active)(false);
        running.view.stop();
        running.window.setDelegate(None);
        running.window.setContentView(None);
        drop(running);
        let resident = RESIDENT.with(|resident| resident.borrow().clone());
        if let Some(resident) = resident {
            (resident.on_close)();
        }
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
/// The caller can finish cleanup or restart after this function returns.
pub fn run_app(source: AppSource, mut options: AppOptions) -> std::process::ExitCode {
    options.notifications = true;
    run_window(Start::Source(source), options, Rc::new(|_| {}), None)
}

/// [`run_app`] for an engine the embedding app configured
/// ([`AppView::load_with_config`]). `on_active` hears, on the main thread,
/// whether the window has the keyboard, from when it opens until it closes.
pub fn run_app_with_config(
    config: EngineConfig,
    options: AppOptions,
    on_active: impl Fn(bool) + 'static,
) -> std::process::ExitCode {
    run_window(
        Start::Config(Box::new(config)),
        options,
        Rc::new(on_active),
        None,
    )
}

enum Start {
    Source(AppSource),
    Config(Box<EngineConfig>),
}

enum Loaded {
    App(App),
    Config(Box<EngineConfig>),
    #[cfg(feature = "dev")]
    DevServer(String),
}

/// Runs a resident application with a native menu-bar entry (Open / Quit).
/// `status_menu` supplies the application-owned button and command labels.
/// Closing the window stops and drops its engine and native views, but keeps
/// the application event loop alive. Open and Dock reopen call `configure` on
/// the main thread to create a fresh engine; an existing window is just raised.
/// `should_close` gates ordinary window close without blocking the main thread:
/// return false while preparing state, then reissue the close when ready.
/// Explicit Quit bypasses this gate. `on_close` runs after each UI is destroyed,
/// including on Quit. Quit returns
/// control to the caller for its own bounded cleanup. Other runners retain
/// their existing close behavior. Must be called on the main thread.
pub fn run_resident_app_with_config(
    options: AppOptions,
    status_menu: crate::StatusMenuOptions,
    configure: impl FnMut() -> EngineConfig + 'static,
    on_active: impl Fn(bool) + 'static,
    on_close: impl Fn() + 'static,
    should_close: impl Fn() -> bool + 'static,
) -> std::process::ExitCode {
    let mut options = options;
    options.keep_alive_on_close = false;
    let resident = Rc::new(Resident {
        options: options.clone(),
        status_menu,
        configure: RefCell::new(Box::new(configure)),
        on_active: Rc::new(on_active),
        on_close: Box::new(on_close),
        should_close: Box::new(should_close),
    });
    let initial = (resident.configure.borrow_mut())();
    run_window(
        Start::Config(Box::new(initial)),
        options,
        resident.on_active.clone(),
        Some(resident),
    )
}

/// Shows one existing UI or constructs a new one on the same connection.
fn reopen_window(delegate: &Delegate) {
    let window = RUNNING.with(|running| {
        running
            .borrow()
            .as_ref()
            .map(|running| running.window.clone())
    });
    let mtm = MainThreadMarker::from(delegate);
    let app = NSApplication::sharedApplication(mtm);
    if let Some(window) = window {
        if window.isMiniaturized() {
            window.deminiaturize(None);
        }
        window.makeKeyAndOrderFront(None);
        app.activate();
    } else if let Some(resident) = RESIDENT.with(|resident| resident.borrow().clone()) {
        let config = (resident.configure.borrow_mut())();
        create_window(
            Start::Config(Box::new(config)),
            &resident.options,
            delegate,
            resident.on_active.clone(),
        );
    }
}

fn run_window(
    start: Start,
    options: AppOptions,
    on_active: Rc<dyn Fn(bool)>,
    resident: Option<Rc<Resident>>,
) -> std::process::ExitCode {
    let mtm = MainThreadMarker::new().expect("run_app must be called on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    // A background app is Prohibited: AppKit does not activate it. An
    // Accessory app is not guaranteed to stay inactive when its window
    // comes up.
    app.setActivationPolicy(if options.background {
        NSApplicationActivationPolicy::Prohibited
    } else {
        NSApplicationActivationPolicy::Regular
    });
    name_app(&options.title);
    crate::chrome::set_app_name(&options.title);
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(mtm), init] };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // A later run finds the app launched already.
    handle_quit_events(Some(&delegate));
    app.setMainMenu(Some(&main_menu(mtm, &options.title)));

    let status = resident.as_ref().map(|resident| {
        let delegate = delegate.clone();
        crate::StatusMenu::new(
            resident.status_menu.clone(),
            move || reopen_window(&delegate),
            quit_app,
        )
    });
    RESIDENT.with(|state| *state.borrow_mut() = resident);
    create_window(start, &options, &delegate, on_active);
    app.run();
    stop_running();
    RESIDENT.with(|state| state.borrow_mut().take());
    drop(status);
    handle_quit_events(None);
    app.setDelegate(None);
    drop(delegate);
    // The new process waits for this one to exit, so the caller's cleanup
    // after `run_app` returns still comes first.
    if RESTART.take() {
        if cfg!(feature = "dev") {
            // `nsh run` ends with its host and stops the dev server: a host
            // started again would be cut off from both, so it only quits.
            log::warn!("a development host quits on restart; restarting runs in a packaged app");
        } else if let Err(err) = nsh_core::restart::spawn_after_exit() {
            log::error!("cannot restart the app: {err}");
        }
    }
    std::process::ExitCode::SUCCESS
}

fn create_window(
    start: Start,
    options: &AppOptions,
    delegate: &Delegate,
    on_active: Rc<dyn Fn(bool)>,
) {
    let mtm = MainThreadMarker::from(delegate);
    let app = NSApplication::sharedApplication(mtm);
    // nsh.json `window`: known before the window is made, so its first
    // frame has it. A dev server's app comes later (its window options with it).
    let loaded = match start {
        Start::Source(AppSource::Rust(root)) => Loaded::App(App::Rust(root)),
        Start::Source(AppSource::Bundle(bundle)) => Loaded::App(App::Js(bundle)),
        #[cfg(feature = "dev")]
        Start::Source(AppSource::DevServer(url)) => Loaded::DevServer(url),
        Start::Config(config) => Loaded::Config(config),
    };
    let loaded_app = match &loaded {
        Loaded::App(app) => Some(app),
        Loaded::Config(config) => Some(&config.app),
        #[cfg(feature = "dev")]
        Loaded::DevServer(_) => None,
    };
    let mut launch = loaded_app
        .and_then(App::main_window)
        .cloned()
        .unwrap_or_default();
    if options.transparent {
        launch.attributes.transparent.get_or_insert(true);
    }
    // With `restoreBounds`, where it was last (the engine keeps it in the
    // app's storage as the window changes), fitted on the displays there
    // are now.
    let kept = match &loaded {
        Loaded::App(app) if launch.restore_bounds => EngineConfig {
            data_dir: options.data_dir.clone().or_else(nsh_engine::data_dir),
            storage: options.storage.clone(),
            ..EngineConfig::new(app.clone())
        }
        .main_window_placement(&crate::window_state::displays(mtm)),
        Loaded::Config(config) if launch.restore_bounds => {
            config.main_window_placement(&crate::window_state::displays(mtm))
        }
        _ => None,
    };
    let size = launch.default_size.map_or(
        NSSize::new(options.size.0 as f64, options.size.1 as f64),
        |s| {
            NSSize::new(
                f64::from(s.width.0.max(1.0)),
                f64::from(s.height.0.max(1.0)),
            )
        },
    );
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), size);
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    let window = crate::window::new_window(
        mtm,
        frame,
        style,
        true,
        options.keep_size,
        options.background,
    );
    // SAFETY: the window is kept in `RUNNING` until it closes.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&options.title));
    window.setDelegate(Some(ProtocolObject::from_ref(delegate)));
    crate::system::open_window(&window, options.appearance);
    let view = AppView::new(mtm, options.clone());
    view.surface().standalone.set(true);
    // The standalone window's attributes own its live transparency state;
    // the surface-only flag remains for embedded AppViews.
    view.surface().transparent.set(false);
    window.setContentView(Some(&view.view()));
    // Nothing is focused until the user or the app focuses it: the root
    // holds the keyboard, so becoming key never lets AppKit pick the first
    // key view (a field, its text selected).
    window.setInitialFirstResponder(Some(view.surface().root.ns()));
    crate::window::launch_main(view.surface(), &window, &launch, kept);
    if kept.is_none()
        && launch.display.is_none()
        && launch.default_position.is_none()
        && let Some(display) = options.display
    {
        center_on_display(&window, display);
    }
    if let Some((width, height)) = options.min_size {
        window.setContentMinSize(NSSize::new(width as f64, height as f64));
    }
    if let Some(name) = &options.frame_autosave_name {
        let name = NSString::from_str(name);
        window.setFrameUsingName(&name);
        window.setFrameAutosaveName(&name);
    }
    match loaded {
        Loaded::App(app) => view.load(app),
        Loaded::Config(config) => view.load_with_config(*config),
        #[cfg(feature = "dev")]
        Loaded::DevServer(url) => crate::dev::start(&view, url),
    }
    if options.background {
        // Shown without activating the app (it never is: its window is
        // never key, and the test agent's input goes to it directly).
        window.orderFrontRegardless();
        window.makeFirstResponder(Some(view.surface().root.ns()));
        // The window that would be key: its state says it has the
        // keyboard, which the test agent's keys go to.
        crate::window::became_key(view.surface(), &window);
    } else {
        window.makeKeyAndOrderFront(None);
        window.makeFirstResponder(Some(view.surface().root.ns()));
        app.activate();
    }
    on_active(window.isKeyWindow());
    let view_surface = view.surface().clone();
    RUNNING.with(|r| {
        *r.borrow_mut() = Some(Running {
            window,
            view,
            keep_alive_on_close: options.keep_alive_on_close,
            on_active,
        })
    });
    // The mode it opens in, once it shows.
    crate::window::launched_main(&view_surface, kept.map(|p| p.mode).or(launch.default_mode));
    for url in URL_SCHEMES.with(|links| std::mem::take(&mut *links.borrow_mut())) {
        url_scheme(url);
    }
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
