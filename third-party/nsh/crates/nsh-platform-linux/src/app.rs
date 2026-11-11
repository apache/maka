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

/// The app's native components ([`set_components`]). Process-wide, as the
/// UI sets of [`set_ui_sets`] are: only the hosts and runners nsh generates
/// for an app's crate set it, so in an embedding app it stays `None` and
/// each registry holds only what was registered on its own view.
static COMPONENTS: RwLock<Option<fn(&crate::native::Components)>> = RwLock::new(None);

/// Sets what registers the app's own native components (`nsh.json`
/// `"rust"`, `#[native_components(linux)]`): every [`AppView`] calls it on
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
    /// Logs the performance monitor's readings once a second (`nsh::fps`:
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
    /// The app this view runs owns the process's notifications (`nsh`'s
    /// `Notifications`). On Linux the desktop portal knows the app by
    /// [`app_id`](Self::app_id) either way, so notifications show without it
    /// too; [`run_app`] sets it, as on macOS and Windows.
    pub notifications: bool,
    /// The embedding app's channel with the apps the view runs
    /// (`nsh/host`): their launch parameters, events to them and handlers of
    /// their calls and posts ([`AppView::host`]). One for every app the view
    /// loads; a new one by default.
    pub host: nsh_engine::HostChannel,
    /// The URL schemes that open the app (nsh.json `schemes`), for
    /// [`run_app`]: it registers them with the desktop, runs one instance
    /// and hands each URL to the app (`UrlScheme.on("open", ...)`). An app
    /// embedding a view hands URLs in with [`AppView::open_url`].
    pub schemes: Vec<String>,
    /// The app runs once (nsh.json `singleInstance`), for [`run_app`]: a
    /// second launch hands its arguments and working directory to the
    /// first (GApplication's `command-line`, over D-Bus, keyed on
    /// [`app_id`](Self::app_id)) and exits before it opens a window; the
    /// first brings its window forward and tells the app
    /// (`Application.on("secondInstance", ...)`).
    pub single_instance: bool,
    /// The file types the app opens (nsh.json `fileTypes`), for
    /// [`run_app`]: its desktop entry lists their MIME types, it runs once,
    /// and hands each file to the app (`Application.on("openFiles", ...)`),
    /// reported as a `file://` URL as for [`schemes`](Self::schemes).
    pub file_types: Vec<nsh_core::file_type::FileType>,
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
            notifications: false,
            host: nsh_engine::HostChannel::default(),
            schemes: Vec::new(),
            single_instance: false,
            file_types: Vec::new(),
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
        *surface.fps_overlay.borrow_mut() = overlay.downgrade();
        let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let outer = gtk::Box::new(gtk::Orientation::Vertical, 0);
        outer.append(&slot);
        outer.append(&overlay);
        surface.outer.set(Some(outer.upcast_ref::<gtk::Widget>()));
        crate::chrome::attach(&surface, &overlay, &slot);
        register_app_components(&options.components);
        surface.native.set_components(options.components.clone());
        surface.native.set_app_id(&options.app_id);
        crate::notifications::set_app(&options.app_id, &options.title);
        let view = Rc::new(AppView {
            surface,
            overlay,
            outer,
            options: RefCell::new(options),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        if view.options.borrow().fps || nsh_engine::perf::enabled_by_env() {
            view.surface.enable_fps();
        }
        view
    }

    /// Hands the app a URL the system opened it with (`UrlScheme.on("open",
    /// ...)` hears it; the app's listener may come later). Before an app
    /// loads, the next one loaded starts at it (`UrlScheme.url()`).
    pub fn open_url(&self, url: &str) {
        self.surface.open_url(url);
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
            content_culling: true,
            network: Some(nsh_engine::net::network()),
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
            // Windows of the app's own are this backend's (`crate::window`).
            windows: None,
        };
        crate::image::set_asset_base(&self.surface, options.asset_base.clone());
        self.surface
            .native
            .set_asset_base(options.asset_base.clone());
        self.surface.start(config);
    }

    /// Loads the host's engine configuration unchanged except for the native
    /// viewport and environment. Its asset reader also serves image views.
    pub fn load_with_config(&self, config: EngineConfig) {
        let access = match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        self.surface.native.set_access(Arc::new(access));
        self.options.borrow_mut().host = config.host.clone();
        self.surface.asset_base.borrow_mut().take();
        self.surface.native.set_asset_base(None);
        *self.surface.image_assets.borrow_mut() = config
            .assets
            .clone()
            .map(|assets| nsh_core::image::loader::ReadAsset::new(move |uri| assets.read(uri)));
        self.surface.start(config);
        self.resume_input();
    }

    /// Refuses physical input and drains already admitted native edits before
    /// acknowledging the host's reload transaction.
    pub fn pause_input(&self, done: impl FnOnce(Result<(), String>) + Send + 'static) {
        if self.surface.input_paused.replace(true) {
            done(Err("input is already paused".into()));
            return;
        }
        crate::input::reset(&self.surface);
        crate::text_input::flush_changes(&self.surface);
        self.surface.input_barrier(done);
    }

    /// Restores input after a cancelled or completed reload.
    pub fn resume_input(&self) {
        self.surface.input_paused.set(false);
        self.outer.set_sensitive(true);
        if let Some(focus) = self
            .surface
            .paused_focus
            .borrow_mut()
            .take()
            .and_then(|f| f.upgrade())
        {
            match focus.downcast_ref::<gtk::Text>() {
                Some(text) => {
                    let _ = text.grab_focus_without_selecting();
                }
                None => {
                    let _ = focus.grab_focus();
                }
            }
        }
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

    /// Answers the native main window's close request with the app's NSH
    /// close policy. An embedding host connects its window's `close-request`
    /// signal to this method while this view is mounted in it.
    pub fn main_close_request(&self) -> glib::Propagation {
        crate::window::main_close_request(&self.surface)
    }

    /// Stops the app.
    pub fn stop(&self) {
        self.surface.stop();
    }

    #[cfg(any(feature = "dev", test))]
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
        file_requests: true,
        native_focus_scopes: true,
        fallback_key_bindings: true,
        notifications: true,
        audio: true,
        // WebKitGTK, in builds with it.
        web_views: cfg!(feature = "webview"),
        // wgpu, in builds with it, until it finds no GPU.
        shaders: nsh_engine::shader::LINKED,
        ..Environment::default()
    }
}

/// The window [`run_app`] shows and its view, once shown.
type Shown = (gtk::ApplicationWindow, Rc<AppView>);

thread_local! {
    /// The standalone app's application ([`run_app`]): what [`quit`] ends.
    static STANDALONE: RefCell<Option<glib::WeakRef<gtk::Application>>> =
        const { RefCell::new(None) };
    /// The app asked to start again when its run ends.
    static RESTART: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Quits the standalone app as [`quit`] does, and starts it again once
/// this process has exited ([`nsh_core::restart`]). A view embedded in
/// another app leaves the app's lifecycle to that app: nothing happens
/// there.
pub(crate) fn restart() {
    if quit() {
        RESTART.set(true);
    }
}

/// Quits the standalone app ([`run_app`]), as its `quit` role and Ctrl+Q:
/// its windows close as the user closing them would, then its run ends,
/// also while something else holds the application (a tray icon). A view
/// embedded in another app leaves the app's lifecycle to that app: false
/// there, with nothing done.
pub(crate) fn quit() -> bool {
    let app = STANDALONE.with(|s| s.borrow().as_ref().and_then(|app| app.upgrade()));
    let Some(app) = app else {
        return false;
    };
    // Not while a surface applies its batch: closing its window stops it.
    glib::idle_add_local_once(move || quit_application(&app));
    true
}

/// Closes `app`'s windows (closing the main one stops its engine), then
/// ends its run.
fn quit_application(app: &gtk::Application) {
    // Closed without asking the app (`closeOnPress`).
    crate::window::set_quitting();
    for window in app.windows() {
        window.close();
    }
    app.quit();
}

/// Runs `source` in a window until it is closed.
pub fn run_app(source: AppSource, mut options: AppOptions) -> glib::ExitCode {
    options.notifications = true;
    prefer_gl_on_nvidia();
    // X11's WM_CLASS comes from the program name: the app's id, as the
    // `StartupWMClass` of the `.desktop` file `nsh package` writes (Wayland's
    // app id is the application id).
    glib::set_prgname(Some(&options.app_id));
    // An app that opens URLs runs once: a second launch hands its URL to
    // the first (GApplication's `open`) and ends.
    let links = !options.schemes.is_empty() || !options.file_types.is_empty();
    // A single-instance app runs once too: a second launch hands its whole
    // command line to the first (`command-line`) and ends.
    let single = options.single_instance;
    let app = gtk::Application::builder()
        .application_id(&options.app_id)
        .flags(if single {
            gtk::gio::ApplicationFlags::HANDLES_COMMAND_LINE
        } else if links {
            gtk::gio::ApplicationFlags::HANDLES_OPEN
        } else {
            gtk::gio::ApplicationFlags::NON_UNIQUE
        })
        .build();
    STANDALONE.with(|s| *s.borrow_mut() = Some(app.downgrade()));
    if links {
        let mut mime_types: Vec<String> = Vec::new();
        for mime in options.file_types.iter().flat_map(|t| &t.mime_types) {
            if !mime_types.contains(mime) {
                mime_types.push(mime.clone());
            }
        }
        crate::links::register(
            &options.app_id,
            &options.title,
            &options.schemes,
            &mime_types,
        );
    }
    let args: Vec<String> = if single {
        std::env::args().collect()
    } else if links {
        crate::links::launch_args(&options.schemes, &options.file_types)
    } else {
        Vec::new()
    };
    let shown: Rc<RefCell<Option<Shown>>> = Rc::default();
    let shown_open = shown.clone();
    // The URLs the app was launched with: the view gets them before its app
    // loads, so they are its address when its code first runs.
    let launch_links: Rc<RefCell<Vec<String>>> = Rc::default();
    let launch_open = launch_links.clone();
    app.connect_open(move |app, files, _| {
        if shown_open.borrow().is_none() {
            launch_open
                .borrow_mut()
                .extend(files.iter().map(|file| file.uri().to_string()));
            app.activate();
            return;
        }
        if let Some((window, view)) = &*shown_open.borrow() {
            for file in files {
                view.open_url(&file.uri());
            }
            window.present();
        }
    });
    let shown_line = shown.clone();
    let launch_line = launch_links.clone();
    let schemes = options.schemes.clone();
    let file_types = options.file_types.clone();
    app.connect_command_line(move |app, line| {
        let mut args: Vec<String> = line
            .arguments()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        // The program's path.
        if !args.is_empty() {
            args.remove(0);
        }
        let cwd = line.cwd();
        let urls: Vec<String> = args
            .iter()
            .filter_map(|arg| {
                if crate::links::is_link(arg, &schemes) {
                    return Some(arg.clone());
                }
                crate::links::file_url(arg, cwd.as_deref(), &file_types)
            })
            .collect();
        // This process's own launch: it opens the window.
        if shown_line.borrow().is_none() {
            launch_line.borrow_mut().extend(urls);
            app.activate();
            return gtk::glib::ExitCode::SUCCESS;
        }
        if let Some((window, view)) = &*shown_line.borrow() {
            let cwd = cwd
                .map(|cwd| cwd.to_string_lossy().into_owned())
                .unwrap_or_default();
            view.surface.event(
                nsh_core::ROOT_ID,
                nsh_core::EventKind::SecondInstance,
                nsh_core::single_instance::SecondInstance::new(args, cwd).to_payload(),
            );
            for url in urls {
                view.open_url(&url);
            }
            window.present();
        }
        gtk::glib::ExitCode::SUCCESS
    });
    let source = RefCell::new(Some(source));
    app.connect_activate(move |app| {
        let Some(source) = source.borrow_mut().take() else {
            if let Some((window, _)) = &*shown.borrow() {
                window.present();
            }
            return;
        };
        // nsh.json `window`: known before the window is made, so its first
        // frame has it.
        // A JS bundle's or a Rust app's root's.
        let app_of: Result<App, String> = match source {
            AppSource::Rust(root) => Ok(App::Rust(root)),
            AppSource::Bundle(bundle) => Ok(App::Js(bundle)),
            #[cfg(feature = "dev")]
            AppSource::DevServer(url) => Err(url),
        };
        let launch = app_of
            .as_ref()
            .ok()
            .and_then(App::main_window)
            .cloned()
            .unwrap_or_default();
        // `restoreBounds`: where its last run left it (the engine keeps it
        // as it changes), fitted on the displays there are.
        let kept = match &app_of {
            Ok(app) if launch.restore_bounds => {
                let mut config = EngineConfig::new(app.clone());
                config.data_dir = options.data_dir.clone().or_else(nsh_engine::data_dir);
                config.storage = options.storage.clone();
                config.main_window_placement(&crate::window::displays())
            }
            _ => None,
        };
        let size = kept
            .map(|p| p.bounds.size)
            .or(launch.default_size)
            .map_or(options.size, |s| {
                (s.width.0.round() as i32, s.height.0.round() as i32)
            });
        let window = gtk::ApplicationWindow::builder()
            .application(app)
            .title(&options.title)
            .default_width(size.0.max(1))
            .default_height(size.1.max(1))
            .build();
        let view = AppView::new(options.clone());
        window.set_child(Some(&view.widget()));
        crate::window::launch_main(
            &view.surface,
            window.upcast_ref(),
            &launch,
            kept.map(|p| p.mode),
        );
        // The user closes it as the app's `closeOnPress` says.
        let weak = Rc::downgrade(&view);
        window.connect_close_request(move |_| match weak.upgrade() {
            Some(view) => view.main_close_request(),
            None => glib::Propagation::Proceed,
        });
        for url in launch_links.take() {
            view.open_url(&url);
        }
        // A development host's window waits for its app, which brings the
        // window's options ([`crate::dev`]).
        let held = app_of.is_err();
        // nsh.json `window.defaultVisible: false`: the window is made and
        // the app runs in it, unseen, until it shows it (a tray app). GTK
        // keeps the mode `launch_main` asked for until it first shows.
        let present = !held && launch.visible_at_launch();
        if !held && !present {
            log::info!("the main window starts hidden (nsh.json window.defaultVisible: false)");
            crate::window::launch_hidden(&view.surface);
        }
        match app_of {
            Ok(app) => view.load(app),
            #[cfg(feature = "dev")]
            Err(url) => crate::dev::start(&view, url),
            // Only a dev server is no app.
            #[cfg(not(feature = "dev"))]
            Err(_) => {}
        }
        install_shortcuts(app, &window);
        *shown.borrow_mut() = Some((window.clone(), view.clone()));
        // The window keeps the view (and its engine) alive.
        unsafe_keep(&window, view);
        if present {
            window.present();
        }
    });
    // GTK must not parse the host's own arguments: only the URL the app
    // was opened with goes to it (`open`).
    let code = app.run_with_args(&args);
    // The new process waits for this one to exit.
    if RESTART.take() {
        if cfg!(feature = "dev") {
            // `nsh run` ends with its host and stops the dev server: a host
            // started again would be cut off from both, so it only quits.
            log::warn!("a development host quits on restart; restarting runs in a packaged app");
        } else if let Err(err) = nsh_core::restart::spawn_after_exit() {
            log::error!("cannot restart the app: {err}");
        }
    }
    code
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
        if let Some(app) = weak.upgrade() {
            quit_application(&app);
        }
    });
    app.add_action(&quit);
    app.set_accels_for_action("app.quit", &["<Control>q"]);
    // GtkWindow's own action. Not an application accelerator: those run
    // before everything, and an app may bind Ctrl+W itself (`nsh/keymap`,
    // e.g. to close a tab); this one comes last.
    crate::window::close_shortcut(window.upcast_ref());
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

#[cfg(all(test, feature = "js"))]
mod tests {
    use std::sync::{Mutex, mpsc};

    use super::*;

    struct Assets;
    impl nsh_engine::Assets for Assets {
        fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
            Ok(uri.as_bytes().to_vec())
        }
    }

    #[test]
    fn configured_load_keeps_host_assets_and_reload_input_lifecycle() {
        crate::gtk_test::run(|| {
            let context = glib::MainContext::default();
            let _owner = context.acquire().unwrap();
            let view = AppView::new(AppOptions {
                asset_base: Some(AssetBase::Directory("/unused".into())),
                ..Default::default()
            });
            view.surface.without_shader_renderer();
            let mut policy = nsh_engine::Policy::default();
            policy
                .declared
                .get_or_insert_default()
                .host
                .push("loaded".into());
            let mut config = EngineConfig::new(
                Bundle::source("import { host } from 'nsh'; host.post('loaded');".into())
                    .with_policy(policy),
            );
            config.assets = Some(Arc::new(Assets));
            let (loaded, loads) = mpsc::channel();
            config.host.handle("loaded", move |_| {
                loaded.send(()).unwrap();
            });
            view.load_with_config(config.clone());
            assert!(crate::gtk_test::wait_until(|| loads.try_recv().is_ok()));
            let assets = nsh_core::image::loader::Context {
                asset_base: view.surface.asset_base.borrow().clone(),
                read_asset: view.surface.image_assets.borrow().clone(),
                ..Default::default()
            };
            let location = assets.resolve("asset:/icon.svg").unwrap();
            let bytes = nsh_core::image::loader::read_now(&location, &assets).unwrap();
            assert_eq!(bytes.bytes(), b"asset:/icon.svg");
            let pending_paste = view.surface.admit_paste();
            let ready = Arc::new(Mutex::new(None));
            let result = ready.clone();
            view.pause_input(move |done| *result.lock().unwrap() = Some(done));
            assert!(view.surface.input_paused.get());
            assert!(view.widget().is_sensitive());
            assert!(ready.lock().unwrap().is_none());
            view.surface.finish_paste(pending_paste);
            assert!(crate::gtk_test::wait_until(|| ready
                .lock()
                .unwrap()
                .is_some()));
            assert_eq!(ready.lock().unwrap().take().unwrap(), Ok(()));
            assert!(!view.widget().is_sensitive());
            view.resume_input();
            assert!(view.widget().is_sensitive());
            view.pause_input(|_| {});
            view.load_with_config(config);
            assert!(crate::gtk_test::wait_until(|| loads.try_recv().is_ok()));
            assert!(view.widget().is_sensitive());
            view.stop();
        });
    }

    #[test]
    fn pausing_without_an_engine_reports_failure_and_can_resume() {
        crate::gtk_test::run(|| {
            let view = AppView::new(Default::default());
            let (send, recv) = mpsc::channel();
            view.pause_input(move |result| send.send(result).unwrap());
            assert_eq!(
                recv.try_recv().unwrap(),
                Err("the UI engine is not running".into())
            );
            view.resume_input();
            assert!(view.widget().is_sensitive());
        });
    }
}
