//! `AppView` (one surface as a GTK widget, for embedding) and the
//! standalone app ([`run_app`]: one `AppView` filling a window).

use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, RwLock},
};

use gtk4::{self as gtk, glib, prelude::*};
use nsh_core::{
    geometry::px,
    platform::{Appearance, Locale},
};
use nsh_engine::{App, Bundle, ColorScheme, EngineConfig, Environment, Idiom, Limits, Os, Root};

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
/// host's root (`nsh test --target linux` of such an app) instead of a
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
    /// Logs the performance monitor's readings once a second (`nsh::perf`:
    /// frame rate, frame and commit costs, CPU, memory).
    pub fps: bool,
    /// Where bundled assets are (for [`AppSource::Bundle`]); dev servers
    /// serve them themselves.
    pub asset_base: Option<AssetBase>,
    /// The application id (`com.example.app`); web views keep their
    /// website data (cookies, storage) under it, in
    /// `$XDG_DATA_HOME/<app id>/webkit`.
    pub app_id: String,
    /// The window title.
    pub title: String,
    /// The initial window size in points.
    pub size: (i32, i32),
    /// The native components apps can use (`nsh/native`); shared by the
    /// views made with these options. See [`AppView::register_component`].
    pub components: crate::native::Components,
    /// The app's appearance until it sets one (`nsh.json` `"appearance"`,
    /// which the bundle sets again when it starts): known before the
    /// first frame, the window opens in it rather than flashing the
    /// system's.
    pub appearance: Appearance,
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
            fps: false,
            asset_base: None,
            app_id: "com.longbridge.nsh.host".to_owned(),
            title: "nsh".to_owned(),
            size: (390, 844),
            components: Default::default(),
            appearance: Appearance::System,
            limits: Limits::default(),
            data_dir: None,
            cache: Default::default(),
            storage: None,
            host: nsh_engine::HostChannel::default(),
        }
    }
}

/// One nsh surface as a GTK widget: an engine running one app.
///
/// ```no_run
/// use std::{cell::RefCell, rc::Rc};
///
/// use gtk::prelude::*;
/// use nsh_platform_linux::{AppOptions, AppView, AssetBase, Bundle, gtk4 as gtk};
///
/// let app = gtk::Application::builder()
///     .application_id("com.example.host")
///     .build();
/// app.connect_activate(|app| {
///     let window = gtk::ApplicationWindow::builder().application(app).build();
///     let view = AppView::new(AppOptions {
///         asset_base: Some(AssetBase::Directory("app/assets".into())),
///         ..AppOptions::default()
///     });
///     let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
///     view.load(Bundle::source(code).into());
///     window.set_child(Some(&view.widget()));
///     // The window keeps the view; closing it stops the app.
///     let keep = RefCell::new(Some(Rc::clone(&view)));
///     window.connect_destroy(move |_| {
///         if let Some(view) = keep.take() {
///             view.stop();
///         }
///     });
///     window.present();
/// });
/// app.run();
/// ```
pub struct AppView {
    surface: Rc<Surface>,
    /// Hosts the surface and, in development, the status line and error
    /// overlay above it.
    #[cfg_attr(not(feature = "dev"), allow(dead_code))]
    overlay: gtk::Overlay,
    /// The widget put in a window: the menu bar's slot above the overlay
    /// ([`crate::chrome`]).
    outer: gtk::Box,
    options: RefCell<AppOptions>,
    #[cfg(feature = "dev")]
    pub(crate) dev: RefCell<Option<crate::dev::DevSession>>,
}

impl AppView {
    /// A view with no app yet.
    pub fn new(options: AppOptions) -> Rc<AppView> {
        let surface = Surface::new(initial_environment());
        surface.appearance.set(options.appearance);
        let overlay = gtk::Overlay::new();
        overlay.set_child(Some(&crate::surface::widget(&surface)));
        overlay.set_vexpand(true);
        let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);
        outer.append(&slot);
        outer.append(&overlay);
        crate::chrome::attach(&surface, &overlay, &slot);
        surface.native.set_components(options.components.clone());
        surface.native.set_app_id(&options.app_id);
        let view = Rc::new(AppView {
            surface,
            overlay,
            outer,
            options: RefCell::new(options),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        if view.options.borrow().fps {
            view.surface.enable_fps();
        }
        view
    }

    /// The widget to put in a window.
    pub fn widget(&self) -> gtk::Widget {
        self.outer.clone().upcast()
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
        let access = match &app {
            App::Js(bundle) => bundle.policy.access(),
            // Native code reaches what the platform allows.
            App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        self.surface.native.set_access(Arc::new(access));
        let options = self.options.borrow();
        let config = EngineConfig {
            app,
            viewport: nsh_core::Size::new(px(0.0), px(0.0)),
            trace: options.trace,
            network: Some(nsh_engine::net::network()),
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
        self.surface
            .native
            .set_asset_base(options.asset_base.clone());
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

    #[cfg(feature = "dev")]
    pub(crate) fn surface(&self) -> &Rc<Surface> {
        &self.surface
    }

    /// The overlay the surface is the child of (development overlays go
    /// above it).
    #[cfg(feature = "dev")]
    pub(crate) fn overlay(&self) -> &gtk::Overlay {
        &self.overlay
    }
}

fn initial_environment() -> Environment {
    Environment {
        window: nsh_core::Size::new(nsh_core::geometry::px(0.0), nsh_core::geometry::px(0.0)),
        color_scheme: ColorScheme::Light,
        os: Os::Linux,
        idiom: Idiom::Desktop,
        ..Environment::default()
    }
}

/// Runs `source` in a window until it is closed.
pub fn run_app(source: AppSource, options: AppOptions) -> glib::ExitCode {
    prefer_gl_on_nvidia();
    // X11's WM_CLASS comes from the program name: the app's id, as the
    // `StartupWMClass` of the `.desktop` file `nsh package` writes (Wayland's
    // app id is the application id).
    glib::set_prgname(Some(&options.app_id));
    let app = gtk::Application::builder()
        .application_id(&options.app_id)
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();
    let source = RefCell::new(Some(source));
    app.connect_activate(move |app| {
        let Some(source) = source.borrow_mut().take() else {
            return;
        };
        let window = gtk::ApplicationWindow::builder()
            .application(app)
            .title(&options.title)
            .default_width(options.size.0)
            .default_height(options.size.1)
            .build();
        let view = AppView::new(options.clone());
        window.set_child(Some(&view.widget()));
        match source {
            AppSource::Rust(root) => view.load(App::Rust(root)),
            AppSource::Bundle(bundle) => view.load(App::Js(bundle)),
            #[cfg(feature = "dev")]
            AppSource::DevServer(url) => crate::dev::start(&view, url),
        }
        install_shortcuts(app, &window);
        // The window keeps the view (and its engine) alive.
        unsafe_keep(&window, view);
        window.present();
    });
    // GTK must not parse the host's own arguments.
    app.run_with_args::<&str>(&[])
}

/// Draws with GSK's GL renderer instead of its Vulkan one (GTK's default
/// since 4.16) under NVIDIA's driver, unless `GSK_RENDERER` chooses: there
/// GSK's Vulkan frames cost the main thread several times as much (the
/// gallery's Animations demo: ~9.5 ms of paint per frame and 73% CPU at
/// 75 fps, against ~1 ms and 14% at 120 fps with GL; `docs/dev/linux.md`).
fn prefer_gl_on_nvidia() {
    if std::env::var_os("GSK_RENDERER").is_some()
        || !std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        return;
    }
    // SAFETY: called before GTK starts, while this thread is the process'
    // only one reading the environment (the engine and the dev client start
    // with the window).
    unsafe { std::env::set_var("GSK_RENDERER", "ngl") };
}

/// GNOME's window shortcuts: Ctrl+W closes the window, Ctrl+Q quits, F11
/// toggles full screen. Accelerators also match the keys of the layout's
/// Latin group, so they work under Cyrillic or Greek layouts too.
fn install_shortcuts(app: &gtk::Application, window: &gtk::ApplicationWindow) {
    let quit = gtk::gio::SimpleAction::new("quit", None);
    let weak = app.downgrade();
    quit.connect_activate(move |_, _| {
        // Closing the windows stops their apps; the last one ends the run.
        if let Some(app) = weak.upgrade() {
            for window in app.windows() {
                window.close();
            }
        }
    });
    app.add_action(&quit);
    app.set_accels_for_action("app.quit", &["<Control>q"]);
    // GtkWindow's own action. Not an application accelerator: those run
    // before everything, and an app may bind Ctrl+W itself (`nsh/keymap`,
    // e.g. to close a tab); this one comes last.
    let close = gtk::ShortcutController::new();
    close.set_propagation_phase(gtk::PropagationPhase::Bubble);
    close.add_shortcut(gtk::Shortcut::new(
        gtk::ShortcutTrigger::parse_string("<Control>w"),
        Some(gtk::NamedAction::new("window.close")),
    ));
    window.add_controller(close);
    let fullscreen = gtk::gio::SimpleAction::new("fullscreen", None);
    let weak = window.downgrade();
    fullscreen.connect_activate(move |_, _| {
        if let Some(window) = weak.upgrade() {
            window.set_fullscreened(!window.is_fullscreen());
        }
    });
    window.add_action(&fullscreen);
    app.set_accels_for_action("win.fullscreen", &["F11"]);
}

/// Ties `view` to `window`'s lifetime.
fn unsafe_keep(window: &gtk::ApplicationWindow, view: Rc<AppView>) {
    let cell = RefCell::new(Some(view));
    window.connect_destroy(move |_| {
        if let Some(view) = cell.borrow_mut().take() {
            view.stop();
        }
    });
}
