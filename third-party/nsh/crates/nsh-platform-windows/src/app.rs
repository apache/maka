//! `AppView` (one surface in a window, for embedding) and the standalone
//! app ([`run_app`]: one `AppView` in a top-level window and the message
//! loop).

pub(crate) mod resident;

use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::{Rc, Weak},
    sync::{Arc, RwLock},
};

use nsh_core::{
    desktop::{Backdrop, MainWindowOptions, WindowMode, WindowPlacement, WindowPosition},
    geometry::{Size, px},
    platform::{Appearance, Locale},
};
use nsh_engine::{App, Bundle, ColorScheme, EngineConfig, Environment, Idiom, Limits, Os, Root};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Ole::OleInitialize,
        UI::{
            HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
            WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
        },
    },
    core::HSTRING,
};

use crate::{
    image::{AssetBase, AssetReader},
    surface::{ActivationHandler, Surface},
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
/// host's root (`nsh test --target windows` of such an app) instead of a
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
/// `"rust"`, `#[native_components(windows)]`): every [`AppView`] calls it on
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
    /// Logs the performance monitor's readings once a second (target
    /// `nsh::perf`): frame rate, frame phases, commits, CPU, memory.
    pub fps: bool,
    /// Where bundled assets are (for [`AppSource::Bundle`]); dev servers
    /// serve them themselves.
    pub asset_base: Option<AssetBase>,
    /// The application id (`com.example.app`): the taskbar groups the app's
    /// windows by it (`AppUserModelID`).
    pub app_id: String,
    /// The window title.
    pub title: String,
    /// The app's icon, an `.ico` file: the window's (title bar, taskbar,
    /// Alt+Tab) when the executable has no icon of its own (the
    /// development host, a runner packaged off Windows), and the one its
    /// notifications show. The release runner reads `nsh\icon.ico`, which
    /// `nsh package` writes; the development host takes `--icon`.
    pub icon: Option<PathBuf>,
    /// The initial window size in points.
    pub size: (i32, i32),
    /// Minimum client area in logical points.
    pub min_size: Option<(i32, i32)>,
    /// A see-through window (Electron's, Tauri's and winit's
    /// `transparent`): where the app draws nothing (no root background),
    /// the desktop shows, and translucent colors blend with it. The
    /// window has no system frame (title bar, borders, shadow): the app
    /// draws what it wants of one and moves the window with
    /// `desktop={{ windowDrag: true }}`. Top-level windows only; set when
    /// the window is made.
    pub transparent: bool,
    /// Keeps the window out of the taskbar from the start (Electron's and
    /// Tauri's `skipTaskbar`); the app changes it with
    /// `Window.setSkipTaskbar`.
    pub skip_taskbar: bool,
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
    /// The app this view runs owns the process's notifications: the process
    /// takes [`app_id`](Self::app_id) as its AppUserModelID (also what the
    /// taskbar groups its windows by), registers it with
    /// [`title`](Self::title) and [`icon`](Self::icon) for toasts and hears
    /// their presses (`nsh`'s `Notifications`). Without it the permission is
    /// `unavailable` and nothing shows. [`run_app`] sets it.
    pub notifications: bool,
    /// The embedding app's channel with the apps the view runs
    /// (`nsh/host`): their launch parameters, events to them and handlers of
    /// their calls and posts ([`AppView::host`]). One for every app the view
    /// loads; a new one by default.
    pub host: nsh_engine::HostChannel,
    /// The URL schemes the app opens (nsh.json `schemes`, from the
    /// package's `nsh\app.json`): [`run_app`] registers them for the
    /// current user, sends the URL it was started with as `EventKind::UrlScheme`
    /// and keeps one instance, a later launch with a URL handing it to the
    /// running one. Empty: none of that.
    pub schemes: Vec<String>,
}

impl Default for AppOptions {
    fn default() -> Self {
        AppOptions {
            trace: false,
            fps: false,
            asset_base: None,
            app_id: "com.longbridge.nsh.host".to_owned(),
            title: "nsh".to_owned(),
            icon: None,
            size: (1200, 800),
            min_size: None,
            transparent: false,
            skip_taskbar: false,
            components: Default::default(),
            appearance: Appearance::System,
            limits: Limits::default(),
            data_dir: None,
            cache: Default::default(),
            storage: None,
            schemes: Vec::new(),
            notifications: false,
            host: nsh_engine::HostChannel::default(),
        }
    }
}

/// One nsh surface in a window: an engine running one app.
///
/// Embedded in another app's window, it is a child window the host
/// positions (`MoveWindow` on its `hwnd()`); the host's message loop runs
/// it (COM must be initialized on the thread, `OleInitialize` for the
/// clipboard).
///
/// ```no_run
/// use nsh_platform_windows::{
///     AppOptions, AppView, AssetBase, Bundle, windows::Win32::Foundation::HWND,
/// };
///
/// # fn host(parent: HWND) -> windows::core::Result<()> {
/// let view = AppView::new(
///     Some(parent),
///     AppOptions {
///         asset_base: Some(AssetBase::Directory("app/assets".into())),
///         ..AppOptions::default()
///     },
/// )?;
/// let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
/// view.load(Bundle::source(code).into());
/// // On WM_SIZE of `parent`: MoveWindow(view.hwnd(), 0, 0, width, height, true).
/// // Destroying the window (or `view.stop()`) stops the app.
/// # Ok(())
/// # }
/// ```
pub struct AppView {
    surface: Rc<Surface>,
    hwnd: HWND,
    options: RefCell<AppOptions>,
    /// The mode the main window takes once shown (nsh.json `window`).
    opening_mode: Cell<Option<WindowMode>>,
    #[cfg(feature = "dev")]
    pub(crate) dev: RefCell<Option<crate::dev::DevSession>>,
}

impl AppView {
    /// A view with no app yet: a child window of `parent`, or a top-level
    /// window (hidden until [`AppView::show`]) when `None`.
    pub fn new(parent: Option<HWND>, options: AppOptions) -> windows::core::Result<Rc<AppView>> {
        let composed = options.transparent;
        AppView::make(parent, options, composed)
    }

    /// [`AppView::new`]; `composed`: a top-level window is shown by a
    /// composition (no redirection bitmap) although it has a frame, for a
    /// system backdrop to show through.
    fn make(
        parent: Option<HWND>,
        options: AppOptions,
        composed: bool,
    ) -> windows::core::Result<Rc<AppView>> {
        let surface = Surface::new(initial_environment());
        surface.appearance.set(options.appearance);
        if options.notifications {
            crate::notifications::start_app(
                &options.app_id,
                &options.title,
                options.icon.as_deref(),
            );
        }
        register_app_components(&options.components);
        surface.native.set_components(options.components.clone());
        surface.native.set_app_id(&options.app_id);
        let transparent = options.transparent && parent.is_none();
        let composed = (composed || transparent) && parent.is_none();
        let hwnd = crate::window::create(&surface, &options.title, options.size, parent, composed)?;
        if composed {
            *surface.base.borrow_mut() = Some(crate::compose::Composition::new(hwnd)?);
        }
        if parent.is_none() {
            crate::window::set_icon(hwnd, options.icon.as_deref());
            // The main window's attributes: a normal window's, with the
            // options'.
            if let Some(shell) = crate::window::shell(hwnd) {
                let mut attrs = shell.attrs();
                attrs.transparent = transparent;
                attrs.taskbar = !options.skip_taskbar;
                if let Some((w, h)) = options.min_size {
                    attrs.min_size = Some(Size::new(px(w as f32), px(h as f32)));
                }
                shell.set(attrs);
                crate::shell::sync(&surface, hwnd, None, attrs);
            }
        }
        let view = Rc::new(AppView {
            surface,
            hwnd,
            options: RefCell::new(options),
            opening_mode: Cell::new(None),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        if view.options.borrow().fps || nsh_engine::perf::enabled_by_env() {
            view.surface.enable_fps();
        }
        Ok(view)
    }

    /// The view's window.
    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// Shows a top-level view's window (in the mode nsh.json `window`
    /// opens it in).
    pub fn show(&self) {
        // Composite the window only once its background is drawn: DWM
        // otherwise shows and animates the default light client surface,
        // which flashes white on a dark appearance until the first frame.
        crate::window::set_cloaked(self.hwnd, true);
        crate::window::fill_background(&self.surface, self.hwnd);
        self.surface.paint();
        crate::window::show(self.hwnd);
        crate::window::set_cloaked(self.hwnd, false);
        if let Some(mode) = self.opening_mode.take() {
            crate::window_state::set_mode(self.hwnd, mode);
        }
    }

    /// Gives the main window what nsh.json `window` sets (`launch`): its
    /// attributes, content size, position, display and mode, or the
    /// placement it was left in (`kept`). A window shown already takes the
    /// mode at once, a hidden one when it shows.
    pub(crate) fn place_main_window(
        &self,
        launch: &MainWindowOptions,
        kept: Option<WindowPlacement>,
    ) {
        let hwnd = self.hwnd;
        if !crate::window_state::top_level(hwnd) {
            return;
        }
        crate::shell::apply(&self.surface, hwnd, &launch.attributes);
        let mode = match kept {
            Some(placement) => {
                crate::window_state::set_placement(hwnd, placement);
                placement.mode
            }
            None => {
                let content = launch
                    .default_size
                    .filter(|s| s.width.0 >= 1.0 && s.height.0 >= 1.0);
                match (launch.default_position, launch.display) {
                    (Some(WindowPosition::At(at)), display) => {
                        let content = content.or_else(|| content_size(hwnd));
                        if let Some(content) = content {
                            crate::window_state::open_at(hwnd, content, Some(at), None, display);
                        }
                    }
                    // The main window has no parent: centered on its display.
                    (Some(_), display) | (None, display @ Some(_)) => {
                        if let Some(content) = content.or_else(|| content_size(hwnd)) {
                            crate::window_state::open_at(hwnd, content, None, None, display);
                        }
                    }
                    (None, None) => {
                        if let Some(content) = content {
                            crate::window_state::size_content(hwnd, content);
                        }
                    }
                }
                launch.default_mode.unwrap_or(WindowMode::Normal)
            }
        };
        // SAFETY: a plain query.
        let visible =
            unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() };
        if visible {
            crate::window_state::set_mode(hwnd, mode);
        } else {
            self.opening_mode
                .set(Some(mode).filter(|m| *m != WindowMode::Normal));
        }
    }

    /// Requests an ordinary window close, including the resident close admission gate.
    pub fn request_close(&self) {
        use windows::Win32::{
            Foundation::{LPARAM, WPARAM},
            UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE},
        };
        // SAFETY: posting to this view's window does not access its UI from the caller.
        if let Err(error) = unsafe { PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }
        {
            log::error!("cannot close the window: {error}");
        }
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
            windows: None,
        };
        crate::image::set_asset_base(&self.surface, options.asset_base.clone());
        self.surface
            .native
            .set_asset_base(options.asset_base.clone());
        self.surface.start(config);
    }

    /// Loads an embedding application's engine configuration.
    pub fn load_with_config(&self, config: EngineConfig) {
        let access = match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        self.surface.native.set_access(Arc::new(access));
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

    /// Choose a directory in a dialog owned by this window.
    /// The callback runs on the UI thread; cancellation is Ok(None).
    pub fn choose_directory(
        &self,
        done: impl FnOnce(Result<Option<PathBuf>, String>) + Send + 'static,
    ) {
        crate::file_requests::choose_directory(&self.surface, done);
    }

    /// Stops the app.
    pub fn stop(&self) {
        self.surface.stop();
    }

    pub(crate) fn surface(&self) -> &Rc<Surface> {
        &self.surface
    }
}

fn initial_environment() -> Environment {
    Environment {
        window: Size::new(px(0.0), px(0.0)),
        color_scheme: ColorScheme::Light,
        os: Os::Windows,
        idiom: Idiom::Desktop,
        native_focus_scopes: true,
        fallback_key_bindings: true,
        file_requests: true,
        notifications: true,
        audio: true,
        ..Environment::default()
    }
}

/// Runs `source` in a window until it is closed.
///
/// The window and its message loop run on a thread of their own, which this
/// one joins: when it ends, its thread-locals (the graphics devices, font
/// faces, bitmaps and the other device resources cached per thread) are
/// released at a plain thread exit. Released by the main thread's
/// thread-local destructors instead, they would run inside `ExitProcess`,
/// after the graphics DLLs and their driver threads are gone, and the
/// process would end with a stray exit code.
pub fn run_app(source: AppSource, mut options: AppOptions) -> std::process::ExitCode {
    wait_for_replaced_process();
    options.notifications = true;
    run(Start::Source(source), options, None)
}

/// Runs an embedding application's [`EngineConfig`] in a window until it is
/// closed. `on_active` follows window activation and receives `false` on
/// shutdown.
pub fn run_app_with_config(
    config: EngineConfig,
    options: AppOptions,
    on_active: impl Fn(bool) + Send + 'static,
) -> std::process::ExitCode {
    wait_for_replaced_process();
    run(
        Start::Config(Box::new(config)),
        options,
        Some(Box::new(on_active)),
    )
}

enum Start {
    Source(AppSource),
    Config(Box<EngineConfig>),
}

static RUNNING_UI: std::sync::Mutex<Option<crate::window::UiThread>> = std::sync::Mutex::new(None);

thread_local! {
    static RUNNING_VIEW: RefCell<Weak<AppView>> = const { RefCell::new(Weak::new()) };
}

/// Runs `f` on the standalone Windows window's UI thread while it is open.
pub fn with_running_view(f: impl FnOnce(&AppView) + Send + 'static) {
    let ui = *RUNNING_UI.lock().unwrap();
    if let Some(ui) = ui {
        ui.invoke(move || {
            RUNNING_VIEW.with(|running| {
                let view = running.borrow().upgrade();
                if let Some(view) = view {
                    f(&view);
                }
            });
        });
    }
}

/// Requests application exit, including when a resident application has no window.
pub fn quit_app() {
    let Some(ui) = *RUNNING_UI.lock().unwrap() else {
        return;
    };
    ui.invoke(|| {
        if resident::running() {
            resident::quit();
        } else {
            with_running_view(|view| {
                use windows::Win32::{
                    Foundation::{LPARAM, WPARAM},
                    UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE},
                };
                // SAFETY: this runs on the owning UI thread and only posts a close request.
                if let Err(error) =
                    unsafe { PostMessageW(Some(view.hwnd()), WM_CLOSE, WPARAM(0), LPARAM(0)) }
                {
                    log::error!("cannot close the Windows app: {error}");
                }
            });
        }
    });
}

fn run(
    start: Start,
    options: AppOptions,
    on_active: Option<ActivationHandler>,
) -> std::process::ExitCode {
    /// The app, moved to the UI thread.
    struct Job(Start, AppOptions, Option<ActivationHandler>);
    // SAFETY: the options hold `Rc`s (the native components), so they are
    // not `Send`. They move to the UI thread whole while this thread waits
    // in `join` and never touches them; clones the caller kept are only
    // used again after `join` returns, once the UI thread has ended, so
    // the reference counts are never changed from two threads at once.
    unsafe impl Send for Job {}
    let job = Job(start, options, on_active);
    let ui = std::thread::Builder::new()
        .name("nsh-ui".into())
        // Deep view trees recurse in drawing and hit testing.
        .stack_size(8 << 20)
        .spawn(move || {
            let job = job;
            run_on_this_thread(job.0, job.1, job.2)
        });
    match ui.map(std::thread::JoinHandle::join) {
        Ok(Ok(code)) => code,
        Ok(Err(_)) => std::process::ExitCode::FAILURE,
        Err(err) => {
            fatal_error(&format!("Cannot start the UI thread: {err}"));
            std::process::ExitCode::FAILURE
        }
    }
}

thread_local! {
    /// The standalone app's UI thread ([`run_app`]): what may restart.
    static STANDALONE: Cell<bool> = const { Cell::new(false) };
    /// The app asked to start again when its run ends.
    static RESTART: Cell<bool> = const { Cell::new(false) };
}

/// Marks the standalone app ([`run_app`]) to start again once its run has
/// ended ([`nsh_core::restart`]); the caller then quits it. A view embedded
/// in another app leaves the app's lifecycle to that app: false there, with
/// nothing marked.
pub(crate) fn request_restart() -> bool {
    STANDALONE.get() && {
        RESTART.set(true);
        true
    }
}

/// Waits, at most [`nsh_core::restart::WAIT_LIMIT`], for the process this
/// one replaces when the app restarted ([`nsh_core::restart::WAIT_FOR_ENV`]),
/// so that the two never run side by side.
fn wait_for_replaced_process() {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let Some(pid) = nsh_core::restart::wait_for_pid() else {
        return;
    };
    // Programs the app starts must not wait for it too.
    // SAFETY: called at the start of `run_app`, before it starts the UI
    // thread or anything else that reads the environment.
    unsafe { std::env::remove_var(nsh_core::restart::WAIT_FOR_ENV) };
    // SAFETY: plain calls; the handle is closed once waited on. A process
    // that has exited already cannot be opened, and nothing waits.
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            let limit = nsh_core::restart::WAIT_LIMIT.as_millis() as u32;
            let _ = WaitForSingleObject(process, limit);
            let _ = CloseHandle(process);
        }
    }
}

/// [`run_app`] on the calling thread.
fn run_on_this_thread(
    start: Start,
    options: AppOptions,
    on_active: Option<ActivationHandler>,
) -> std::process::ExitCode {
    STANDALONE.set(true);
    // SAFETY: process setup before any window exists: per-monitor DPI
    // (points stay sharp on every monitor) and an OLE apartment for the
    // clipboard, drag and drop and WIC.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = OleInitialize(None);
    }
    if let crate::linking::Start::Forwarded =
        crate::linking::start(&options.app_id, &options.title, &options.schemes)
    {
        return std::process::ExitCode::SUCCESS;
    }
    // The app to run, when it is known now (a dev server's comes later).
    let app = match &start {
        Start::Source(AppSource::Rust(root)) => Some(App::Rust(root.clone())),
        Start::Source(AppSource::Bundle(bundle)) => Some(App::Js(bundle.clone())),
        #[cfg(feature = "dev")]
        Start::Source(AppSource::DevServer(_)) => None,
        Start::Config(config) => Some(config.app.clone()),
    };
    // nsh.json `window` (a bundle's, or compiled into a Rust app's root):
    // known before the window is made, so that its first frame has it.
    let launch = app
        .as_ref()
        .and_then(App::main_window)
        .cloned()
        .unwrap_or_default();
    let mut options = options;
    if launch.attributes.transparent == Some(true) {
        options.transparent = true;
    }
    // A backdrop shows through a window without a redirection bitmap.
    let composed = options.transparent
        || launch
            .attributes
            .backdrop
            .is_some_and(|b| b != Backdrop::None);
    // `restoreBounds`: where its last run left it (the engine keeps it
    // as it changes), fitted on the displays there are.
    let kept = match app {
        Some(app) if launch.restore_bounds => {
            let mut config = EngineConfig::new(app);
            config.data_dir = options.data_dir.clone().or_else(nsh_engine::data_dir);
            config.storage = options.storage.clone();
            config.main_window_placement(&crate::window_state::displays())
        }
        _ => None,
    };
    let view = match AppView::make(None, options.clone(), composed) {
        Ok(view) => view,
        Err(err) => {
            fatal_error(&format!("Cannot open a window: {err}"));
            return std::process::ExitCode::FAILURE;
        }
    };
    *view.surface.on_activation.borrow_mut() = on_active;
    RUNNING_VIEW.with(|running| *running.borrow_mut() = Rc::downgrade(&view));
    *RUNNING_UI.lock().unwrap() = Some(crate::window::UiThread::current());
    match start {
        Start::Source(AppSource::Rust(root)) => view.load(App::Rust(root)),
        Start::Source(AppSource::Bundle(bundle)) => view.load(App::Js(bundle)),
        #[cfg(feature = "dev")]
        Start::Source(AppSource::DevServer(url)) => crate::dev::start(&view, url),
        Start::Config(config) => view.load_with_config(*config),
    }
    crate::system::environment_applied(view.surface());
    crate::linking::attach(view.surface());
    install_shortcuts(&view);
    view.place_main_window(&launch, kept);
    view.show();
    let code = crate::window::run_loop();
    view.surface.activation_changed(false);
    *RUNNING_UI.lock().unwrap() = None;
    RUNNING_VIEW.with(|running| *running.borrow_mut() = Weak::new());
    view.stop();
    drop(view);
    // SAFETY: pairs the `OleInitialize` above; nothing on this thread uses
    // OLE afterwards.
    unsafe { windows::Win32::System::Ole::OleUninitialize() };
    STANDALONE.set(false);
    // The new process waits for this one to exit ([`wait_for_replaced_process`]).
    if RESTART.take() {
        if cfg!(feature = "dev") {
            // `nsh run` ends with its host and stops the dev server: a host
            // started again would be cut off from both, so it only quits.
            log::warn!("a development host quits on restart; restarting runs in a packaged app");
        } else if let Err(err) = nsh_core::restart::spawn_after_exit() {
            log::error!("cannot restart the app: {err}");
        }
    }
    if code == 0 {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

/// The content size of `hwnd` in points.
fn content_size(hwnd: HWND) -> Option<Size<nsh_core::Points>> {
    let mut rect = windows::Win32::Foundation::RECT::default();
    // SAFETY: a query with a local out value.
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect) }.ok()?;
    let scale = crate::window::dpi(hwnd) as f32 / 96.0;
    Some(Size::new(
        px((rect.right - rect.left) as f32 / scale),
        px((rect.bottom - rect.top) as f32 / scale),
    ))
}

/// The standalone app's window shortcuts: F11 toggles full screen, as in
/// Windows' own apps (Alt+F4, which closes the window, is the system's).
fn install_shortcuts(view: &AppView) {
    const VK_F11: u16 = 0x7A;
    let hwnd = view.hwnd();
    view.surface()
        .shortcuts
        .borrow_mut()
        .push(Box::new(move |event| {
            let m = event.modifiers;
            if event.vk != VK_F11 || m.ctrl || m.alt || m.shift || m.meta {
                return false;
            }
            // A key held down toggles once.
            if !event.repeat {
                crate::window::toggle_full_screen(hwnd);
            }
            true
        }));
}

/// Writes `text` to the debugger's output (`OutputDebugString`): where a
/// windowed program's logs go.
pub fn debug_output(text: &str) {
    use windows::Win32::System::Diagnostics::Debug::OutputDebugStringW;
    // SAFETY: a valid, NUL-terminated string.
    unsafe { OutputDebugStringW(&HSTRING::from(text)) };
}

/// Shows `message` in an error box (a windowed program has no console).
pub fn fatal_error(message: &str) {
    log::error!("{message}");
    // SAFETY: valid strings; no owner window.
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from("nsh"),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(test)]
mod tests {
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, GWL_EXSTYLE, GWL_STYLE, GetWindowLongPtrW, WS_CAPTION,
        WS_EX_NOREDIRECTIONBITMAP,
    };

    use super::*;

    fn styles(hwnd: HWND) -> (u32, u32) {
        // SAFETY: plain reads on a live window.
        unsafe {
            (
                GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
                GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
            )
        }
    }

    #[test]
    fn transparent_window_is_borderless_and_composed() {
        let view = AppView::new(
            None,
            AppOptions {
                size: (200, 120),
                transparent: true,
                skip_taskbar: true,
                ..Default::default()
            },
        )
        .unwrap();
        let (style, ex) = styles(view.hwnd());
        assert_eq!(style & WS_CAPTION.0, 0, "no system frame");
        assert_ne!(ex & WS_EX_NOREDIRECTIONBITMAP.0, 0, "no redirection bitmap");
        let surface = view.surface();
        assert!(surface.transparent());
        let shell = crate::window::shell(view.hwnd()).unwrap();
        assert!(!shell.attrs().taskbar);
        assert!(shell.attrs().frameless());
        assert_eq!(
            crate::system::window_background(surface),
            nsh_core::Color::TRANSPARENT
        );
        crate::render::frame(surface);
        if crate::gfx::get().is_ok() {
            let swap = surface.swap.borrow();
            assert!(swap.as_ref().is_some_and(|s| s.premultiplied()));
            assert!(surface.base.borrow().as_ref().is_some_and(|c| c.has_base()));
        }
        // SAFETY: the test's own window.
        let _ = unsafe { DestroyWindow(view.hwnd()) };
    }

    #[test]
    fn opaque_window_keeps_its_frame() {
        let view = AppView::new(None, AppOptions::default()).unwrap();
        let (style, ex) = styles(view.hwnd());
        assert_ne!(style & WS_CAPTION.0, 0);
        assert_eq!(ex & WS_EX_NOREDIRECTIONBITMAP.0, 0);
        assert!(!view.surface().transparent());
        assert!(crate::window::shell(view.hwnd()).unwrap().attrs().taskbar);
        // SAFETY: the test's own window.
        let _ = unsafe { DestroyWindow(view.hwnd()) };
    }
}
