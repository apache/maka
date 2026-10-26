//! `AppView` (one surface in a window, for embedding) and the standalone
//! app ([`run_app`]: one `AppView` in a top-level window and the message
//! loop).

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
    surface::Surface,
};

static UI_SETS: RwLock<Option<Vec<nsh_core::ui::Registry>>> = RwLock::new(None);

/// Sets the UI sets every engine serves (default: `nsh/base`); an app
/// with Rust components of its own calls this before [`run_app`].
pub fn set_ui_sets(sets: Vec<nsh_core::ui::Registry>) {
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

/// The UI sets engines serve.
pub(crate) fn ui_sets() -> Vec<nsh_core::ui::Registry> {
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
            size: (1200, 800),
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
    #[cfg(feature = "dev")]
    pub(crate) dev: RefCell<Option<crate::dev::DevSession>>,
}

impl AppView {
    /// A view with no app yet: a child window of `parent`, or a top-level
    /// window (hidden until [`AppView::show`]) when `None`.
    pub fn new(parent: Option<HWND>, options: AppOptions) -> windows::core::Result<Rc<AppView>> {
        let surface = Surface::new(initial_environment());
        surface.appearance.set(options.appearance);
        surface.native.set_components(options.components.clone());
        surface.native.set_app_id(&options.app_id);
        let hwnd = crate::window::create(&surface, &options.title, options.size, parent)?;
        let view = Rc::new(AppView {
            surface,
            hwnd,
            options: RefCell::new(options),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        });
        crate::system::watch_environment(&view.surface);
        if view.options.borrow().fps {
            view.surface.enable_fps();
        }
        Ok(view)
    }

    /// The view's window.
    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    /// Shows a top-level view's window.
    pub fn show(&self) {
        crate::window::show(self.hwnd);
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
    /// inputs, the components' labels, alerts and toasts) is laid out again
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
}

fn initial_environment() -> Environment {
    Environment {
        window: Size::new(px(0.0), px(0.0)),
        color_scheme: ColorScheme::Light,
        os: Os::Windows,
        idiom: Idiom::Desktop,
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
pub fn run_app(source: AppSource, options: AppOptions) -> std::process::ExitCode {
    /// The app, moved to the UI thread.
    struct Job(AppSource, AppOptions);
    // SAFETY: the options hold `Rc`s (the native components), so they are
    // not `Send`. They move to the UI thread whole while this thread waits
    // in `join` and never touches them; clones the caller kept are only
    // used again after `join` returns, once the UI thread has ended, so
    // the reference counts are never changed from two threads at once.
    unsafe impl Send for Job {}
    let job = Job(source, options);
    let ui = std::thread::Builder::new()
        .name("nsh-ui".into())
        // Deep view trees recurse in drawing and hit testing.
        .stack_size(8 << 20)
        .spawn(move || {
            let job = job;
            run_on_this_thread(job.0, job.1)
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

/// [`run_app`] on the calling thread.
fn run_on_this_thread(source: AppSource, options: AppOptions) -> std::process::ExitCode {
    // SAFETY: process setup before any window exists: per-monitor DPI
    // (points stay sharp on every monitor) and an OLE apartment for the
    // clipboard, drag and drop and WIC.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = OleInitialize(None);
    }
    crate::system::set_app_id(&options.app_id);
    let view = match AppView::new(None, options.clone()) {
        Ok(view) => view,
        Err(err) => {
            fatal_error(&format!("Cannot open a window: {err}"));
            return std::process::ExitCode::FAILURE;
        }
    };
    match source {
        AppSource::Rust(root) => view.load(App::Rust(root)),
        AppSource::Bundle(bundle) => view.load(App::Js(bundle)),
        #[cfg(feature = "dev")]
        AppSource::DevServer(url) => crate::dev::start(&view, url),
    }
    crate::system::environment_applied(view.surface());
    install_shortcuts(&view);
    view.show();
    let code = crate::window::run_loop();
    view.stop();
    drop(view);
    // SAFETY: pairs the `OleInitialize` above; nothing on this thread uses
    // OLE afterwards.
    unsafe { windows::Win32::System::Ole::OleUninitialize() };
    if code == 0 {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
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
