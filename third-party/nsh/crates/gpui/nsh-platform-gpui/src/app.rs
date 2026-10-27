//! `AppView` (one surface as a GPUI view, for embedding in any GPUI or
//! GPUI Kit app) and the development host's window ([`run_app`]: one
//! `AppView` filling a window).

use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, RwLock},
};

use gpui::{
    App as GpuiApp, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement,
    IntoElement, ParentElement, Render, Styled, Window, prelude::FluentBuilder as _,
};
use nsh_base::{Theme, ThemeError};
use nsh_core::platform::{Appearance, Locale};
use nsh_engine::{
    App, AppError, Bundle, ColorScheme, EngineConfig, Environment, Idiom, Limits, Os, Root,
};

use crate::{
    image::{AssetBase, AssetReader},
    render::SurfaceElement,
    surface::Surface,
};

gpui::actions!(
    nsh,
    [
        /// Tab in a surface: its next text field, or the window's next tab
        /// stop.
        FocusNext,
        /// Shift + Tab in a surface: its previous text field, or the
        /// window's previous tab stop.
        FocusPrev
    ]
);

/// The key context of [`AppView`]: its Tab bindings are deeper than an
/// embedding app's (GPUI Kit's `Root` binds Tab to move the window's
/// focus), so the surface's text fields come first.
const KEY_CONTEXT: &str = "NshAppView";

/// Marks the app whose key bindings are set ([`bind_keys`]).
struct KeysBound;

impl gpui::Global for KeysBound {}

/// Binds Tab and Shift + Tab in surfaces, once per app.
fn bind_keys(cx: &mut GpuiApp) {
    if cx.has_global::<KeysBound>() {
        return;
    }
    restore_keys(cx);
}

/// Restores surface Tab bindings after the native menu clears the app's keymap.
pub(crate) fn restore_keys(cx: &mut GpuiApp) {
    cx.set_global(KeysBound);
    cx.bind_keys([
        gpui::KeyBinding::new("tab", FocusNext, Some(KEY_CONTEXT)),
        gpui::KeyBinding::new("shift-tab", FocusPrev, Some(KEY_CONTEXT)),
    ]);
}

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
/// host's root (`nsh test --target gpui` of such an app) instead of a
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
// Made once per app and moved into it: the size of a bundle is no cost.
#[allow(clippy::large_enum_variant)]
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
    /// Use Control-based terminal shortcuts while retaining graphical rendering.
    pub terminal_keyboard: bool,
    /// Where bundled assets are (for [`AppSource::Bundle`]); dev servers
    /// serve them themselves.
    pub asset_base: Option<AssetBase>,
    /// The application id (`com.example.app`).
    pub app_id: String,
    /// The window title.
    pub title: String,
    /// The initial window size in points.
    pub size: (i32, i32),
    /// The native components apps can use (`nsh/native`); shared by the
    /// views made with these options. See [`AppView::register_component`].
    pub components: crate::native::Components,
    /// The app's appearance until it sets one (`nsh.json` `"appearance"`).
    pub appearance: Appearance,
    /// Log frame statistics once a second (`nsh::perf fps …`): see
    /// [`AppView::set_fps_monitor`].
    pub fps: bool,
    /// The VM limits of the apps it runs: [`Limits::default`] (an app
    /// embedded in a host app) unless set; the development host runs
    /// apps on their own, with none ([`Limits::standalone`]). See [`AppView::set_limits`].
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
    /// What the embedding app gives the engines of the views made with
    /// these options ([`nsh_engine::EngineConfig::context`]): its UI sets'
    /// functions read it with `nsh_core::element::engine_context`, so each view
    /// reaches its own part of the embedding app.
    pub context: nsh_engine::EngineContext,
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
            terminal_keyboard: false,
            asset_base: None,
            app_id: "com.longbridge.nsh.host".to_owned(),
            title: "nsh".to_owned(),
            size: (1200, 800),
            components: Default::default(),
            appearance: Appearance::System,
            fps: false,
            limits: Limits::default(),
            data_dir: None,
            cache: Default::default(),
            storage: None,
            context: Default::default(),
            host: nsh_engine::HostChannel::default(),
        }
    }
}

/// What a person asked of the window an [`AppView`] owns
/// ([`AppView::own_window`]), handed to [`AppView::on_close_request`]'s
/// handler instead of being carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CloseRequest {
    /// Quit the app: the reserved quit key (Ctrl+Q, Cmd+Q on macOS) or a
    /// menu item with the `quit` role.
    Quit,
    /// Close the window: Ctrl+W (Cmd+W on macOS) the app does not bind, a
    /// menu item with the `close` role, `Window.close()`, or the window's
    /// close button.
    Close,
}

/// One nsh surface as a GPUI view: an engine running one app, drawn by
/// GPUI wherever the embedding app puts the view (it fills the space its
/// parent element gives it, and follows it when it is resized).
///
/// Embedded in a GPUI or GPUI Kit app:
///
/// - Several views can run at once, in one window or several: each has
///   its own engine thread. Dropping the view (its last `Entity` handle)
///   stops its engine; so does [`AppView::stop`].
/// - The view is [`Focusable`] and a tab stop: Tab moves the window's
///   focus into it (and through its text fields), and on out of it after
///   the last one. A press on it focuses it.
/// - [`AppView::set_theme`] / [`AppView::set_theme_json`] give the app the
///   embedding app's theme (shadcn's `cssVars` theme format) and
///   [`AppView::set_appearance`] its light or dark mode.
/// - What the app tells the embedding app goes through the native
///   components the latter registers ([`AppView::register_component`]):
///   their events and commands. [`AppView::on_app_error`] hears the app's
///   errors.
/// - The view draws only inside its bounds: the host's overlays (GPUI
///   Kit's dialogs, popovers, notifications) draw above it.
/// - Open the host window with `inactive_frame_interval: None` in its
///   `WindowOptions`: GPUI draws unfocused windows at 30 fps by default,
///   which halves the surface's animations whenever the window does not
///   have the keyboard (nsh's own windows set it).
///
/// Most methods take `&self` and can be called through `view.read(cx)`:
/// they hand work to the engine thread, whose next frame redraws the view.
/// [`AppView::set_theme`], [`AppView::set_theme_json`] and
/// [`AppView::set_appearance`] also change what the main thread draws (the
/// surface's background, its light or dark environment) without waiting
/// for the engine, so they take `cx` to redraw at once: call them through
/// `view.update(cx, |view, cx| …)`.
///
/// ```no_run
/// use gpui::{AppContext, Application, WindowOptions};
/// use nsh_platform_gpui::{App, AppOptions, AppView, Bundle};
///
/// gpui_platform::application().run(|cx| {
///     cx.open_window(WindowOptions::default(), |window, cx| {
///         cx.new(|cx| {
///             let view = AppView::new(AppOptions::default(), window, cx);
///             let code = std::fs::read_to_string("app/bundle.js").expect("bundle");
///             view.load(App::Js(Bundle::source(code)));
///             view
///         })
///     })
///     .unwrap();
/// });
/// ```
pub struct AppView {
    surface: Rc<Surface>,
    focus: FocusHandle,
    options: RefCell<AppOptions>,
    /// Tab into the view from the host's widgets ([`AppView::tab_entered`]).
    _keystrokes: gpui::Subscription,
    /// The view itself handled the Tab being dispatched ([`AppView::tab`]).
    tabbed: std::cell::Cell<bool>,
    /// Answers the apps' picks in place of GPUI's open dialog
    /// ([`AppView::set_picker`]).
    picker: RefCell<Option<Arc<dyn nsh_core::picker::PickerBackend>>>,
    #[cfg(feature = "dev")]
    pub(crate) dev: RefCell<Option<crate::dev::DevSession>>,
}

impl AppView {
    /// Cancels the current native mouse contact and hover without changing focus.
    /// Embedders call this when their terminal loses the physical pointer.
    pub fn cancel_pointer(&self) {
        crate::input::cancel_pointer(&self.surface);
    }

    /// Delivers a user paste to the current editable input, reporting its
    /// content before inserting text according to the input's paste policy.
    /// Returns whether the focused input accepted the paste.
    pub fn paste(&self, paste: nsh_core::PasteEvent) -> bool {
        let Some(view) = crate::text_input::focused(&self.surface) else {
            return false;
        };
        crate::text_input::paste_content(&self.surface, &view, paste)
    }

    /// A view with no app yet (in `cx.new(|cx| AppView::new(...))`).
    pub fn new(options: AppOptions, window: &mut Window, cx: &mut Context<Self>) -> AppView {
        crate::rt::init(cx);
        // Revoke the native field's admission on activation changes even
        // while terminal pixel output defers the next paint.
        cx.observe_window_activation(window, |view: &mut AppView, window, cx| {
            crate::text_input::window_focus(
                &view.surface,
                window.is_window_active() && view.focus.is_focused(window),
            );
            cx.notify();
        })
        .detach();
        bind_keys(cx);
        let surface = Surface::new(Environment {
            terminal_keyboard: options.terminal_keyboard,
            ..initial_environment()
        });
        surface.appearance.set(options.appearance);
        if options.fps {
            *surface.stats.borrow_mut() = Some(Default::default());
        }
        surface.entity.set(Some(cx.entity_id()));
        *surface.text_system.borrow_mut() = Some(cx.text_system().clone());
        surface.native.set_components(options.components.clone());
        crate::system::watch_environment(&surface, window, cx);
        // The chrome follows the window: full screen, maximized, active.
        cx.observe_window_bounds(window, |_, _, cx| cx.notify())
            .detach();
        cx.observe_window_activation(window, |view: &mut AppView, window, cx| {
            if !window.is_window_active() {
                crate::keymap::forget_held(&view.surface);
            }
            cx.notify();
        })
        .detach();
        AppView {
            surface,
            focus: cx.focus_handle().tab_stop(true),
            options: RefCell::new(options),
            tabbed: std::cell::Cell::new(false),
            picker: RefCell::new(None),
            _keystrokes: cx.observe_keystrokes(Self::tab_entered),
            #[cfg(feature = "dev")]
            dev: RefCell::new(None),
        }
    }

    /// Runs `app`, replacing what ran.
    pub fn load(&self, app: App) {
        let options = self.options.borrow();
        let config = EngineConfig {
            app,
            viewport: nsh_core::Size::default(),
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
            context: options.context.clone(),
            pinned: Default::default(),
            clipboard: None,
            host: options.host.clone(),
            picker: self.picker.borrow().clone(),
        };
        drop(options);
        self.start(config, false);
    }

    /// Runs the host's original engine configuration, replacing what ran.
    ///
    /// The GPUI surface supplies its actual viewport and device environment.
    /// The remaining settings, including UI registries, runtime, bundle policy
    /// and asset reader, are kept. Its asset reader serves both engine resources
    /// and image `asset:/` URIs; `None` makes those URIs unavailable. The provider
    /// stays bound to this load, independently of [`Self::set_asset_base`].
    pub fn load_with_config(&self, config: EngineConfig) {
        self.start(config, true);
    }

    fn start(&self, config: EngineConfig, use_engine_assets: bool) {
        let access = match &config.app {
            App::Js(bundle) => bundle.policy.access(),
            App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        self.surface.native.set_access(Arc::new(access));
        let base = self.options.borrow().asset_base.clone();
        crate::image::set_asset_base(&self.surface, base.clone());
        self.surface.native.set_asset_base(base);
        self.surface.start(config, use_engine_assets);
    }

    /// Runs a verified signed package ([`crate::verify_package`] or
    /// [`crate::load_package`], off the main thread: they hash the package
    /// and write its assets), its assets from where they were unpacked,
    /// replacing what ran. A package from [`crate::verify_package`] is
    /// accepted with [`crate::accept_package`] once the embedding app
    /// decided it is healthy; until then the build it ran before still
    /// verifies, to go back to.
    #[cfg(feature = "js")]
    pub fn run_package(&self, package: &nsh_engine::LoadedPackage) {
        self.set_asset_base(Some(AssetBase::Directory(package.assets.clone())));
        self.load(App::Js(package.bundle.clone()));
    }

    /// Where `asset:/` URIs resolve: at once for the images, videos and
    /// web views the running app loads from now on, and for every app
    /// loaded later. Fonts the running app already registered stay; a
    /// running engine keeps reading the files it asks for itself (fonts)
    /// from the base it was loaded with, until the next [`AppView::load`].
    /// An explicit [`Self::load_with_config`] asset reader stays bound to that
    /// load; changing this base does not replace that provider.
    pub fn set_asset_base(&self, base: Option<AssetBase>) {
        crate::image::set_asset_base(&self.surface, base.clone());
        self.surface.native.set_asset_base(base.clone());
        self.options.borrow_mut().asset_base = base;
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

    /// Answers the picks of the apps loaded from now on
    /// (`Picker.pickImages`) with `picker`, the embedding app's own picker,
    /// instead of showing GPUI's open dialog; `None`: the dialog again.
    pub fn set_picker(&self, picker: Option<Arc<dyn nsh_core::picker::PickerBackend>>) {
        *self.picker.borrow_mut() = picker;
    }

    /// Development: loads the app from a `nsh dev` server (`ws://host:port/ws`)
    /// and loads it again on every rebuild (in place when it can: hot
    /// updates), with the dev server's assets, its logs forwarded to the
    /// developer's terminal, and build and runtime errors shown over the
    /// app (Ctrl+R, Cmd+R on macOS, or F5 loads the latest build again).
    /// [`AppView::on_error`] still hears the app's errors. Connecting again
    /// replaces the session; dropping the view ends it. Call it through
    /// `view.update(cx, |view, cx| …)`.
    #[cfg(feature = "dev")]
    pub fn connect_dev_server(&self, url: impl Into<String>, cx: &mut Context<Self>) {
        crate::dev::start(self, url.into(), cx);
    }

    /// Registers native component `name` (`nativeComponent(name, ...)` in
    /// JS): `factory` makes one for every element. Applies to elements
    /// created from now on.
    pub fn register_component(&self, name: &str, factory: crate::native::ComponentFactory) {
        self.surface.native.components().register(name, factory);
    }

    /// Makes the window this view is drawn in its own, as
    /// [`open_app_window`]'s is: the app's title (`Window.setTitle`), title
    /// bar, application menu (macOS's menu bar, the menu bar drawn above
    /// the view elsewhere) and window operations act on it, and the
    /// window's reserved keys are the view's. The embedding app opens the
    /// window itself (its bounds, its root element: GPUI Kit's `Root`
    /// around the view, say), best with [`crate::titlebar_options`], and
    /// calls this once, from the window's build closure.
    pub fn own_window(&self, window: &Window, cx: &GpuiApp) {
        let title = window.window_title();
        crate::chrome::set_standalone(&self.surface, &title, window.window_handle());
        crate::system::own_window(&self.surface);
        let surface = Rc::downgrade(&self.surface);
        window.on_window_should_close(cx, move |window, cx| {
            surface.upgrade().is_none_or(|surface| {
                !crate::chrome::ask_to_close(&surface, CloseRequest::Close, window, cx)
            })
        });
    }

    /// Hands the quit and close requests of the window the view owns
    /// ([`AppView::own_window`]) to `f`, which decides: the reserved quit
    /// key, Ctrl+W, the `quit` and `close` menu roles, `Window.close()` and
    /// the window's close button no longer quit or close by themselves.
    /// `f` runs on the main thread after the event that asked; it quits
    /// with `cx.quit()` or closes with `window.remove_window()` when the
    /// embedding app is ready to. Replaces the handler set before.
    pub fn on_close_request(&self, f: impl Fn(CloseRequest, &mut Window, &mut GpuiApp) + 'static) {
        *self.surface.chrome.on_close.borrow_mut() = Some(Rc::new(f));
    }

    /// Stops the app.
    pub fn stop(&self) {
        self.surface.stop();
    }

    /// Gives the app the embedding app's theme: the components of the UI
    /// sets (`nsh/base`, an app's own) render with it instead of the app's own
    /// (`nsh.json` `"theme"`), and the surface is drawn on its
    /// `background`. `None` gives the app its own theme back. It applies
    /// at once to what runs and to every app loaded later, from its first
    /// frame on.
    pub fn set_theme(&self, theme: Option<Theme>, cx: &mut GpuiApp) {
        *self.surface.host_theme.borrow_mut() = theme.clone();
        self.surface
            .control(|c| c.set_tokens(theme.map(Theme::into_tokens)));
        self.surface.invalidate();
        crate::rt::flush(cx);
    }

    /// [`AppView::set_theme`] with a theme file of shadcn/ui's
    /// (`{ "cssVars": { "theme": { … }, "light": { … }, "dark": { … } } }`,
    /// values as CSS writes them), over `nsh/base`'s default theme.
    pub fn set_theme_json(&self, json: &str, cx: &mut GpuiApp) -> Result<(), ThemeError> {
        let theme = Theme::from_json(json)?;
        self.set_theme(Some(theme), cx);
        Ok(())
    }

    /// The embedding app's appearance, which stands in for the system's:
    /// [`Appearance::Light`] or [`Appearance::Dark`] (the host's own light
    /// or dark mode), or [`Appearance::System`] to follow the window's
    /// again. An appearance the app sets itself (`nsh.json`
    /// `"appearance"`, `setColorScheme`) still wins, as it does over the
    /// system's.
    pub fn set_appearance(&self, appearance: Appearance, cx: &mut GpuiApp) {
        self.surface.host_dark.set(match appearance {
            Appearance::Light => Some(false),
            Appearance::Dark => Some(true),
            _ => None,
        });
        crate::system::host_appearance_changed(&self.surface);
        crate::rt::flush(cx);
    }

    /// The embedding app's locale, which stands in for the user's: what
    /// `Intl` formats for by default and what `locale()` (`nsh/device`) and
    /// Rust components' `locale()` read, at once and for every app loaded
    /// later. `None` follows the system's again.
    pub fn set_locale(&self, locale: Option<Locale>, cx: &mut GpuiApp) {
        let mut host = self.surface.host_environment.get();
        host.locale = locale;
        self.surface.host_environment.set(host);
        crate::system::host_appearance_changed(&self.surface);
        crate::rt::flush(cx);
    }

    /// The embedding app's text size relative to the default (1.0), which
    /// stands in for the user's: every text that allows font scaling (texts,
    /// inputs, the components' labels and alerts) is laid out again
    /// at it, and `fontScale()` reads it, at once and for every app loaded
    /// later. Lengths stay as they are (spacing, sizes, radii, `rem`):
    /// boxes sized by their text grow with it. `None` follows the system's
    /// again.
    pub fn set_font_scale(&self, scale: Option<f32>, cx: &mut GpuiApp) {
        let mut host = self.surface.host_environment.get();
        host.font_scale = scale;
        self.surface.host_environment.set(host);
        crate::system::host_appearance_changed(&self.surface);
        crate::rt::flush(cx);
    }

    /// Logs the surface's frame statistics once a second (`nsh::perf fps
    /// …`: frames drawn, their gaps, the main thread's tick and paint, what
    /// made GPUI draw), or stops.
    pub fn set_fps_monitor(&self, on: bool) {
        *self.surface.stats.borrow_mut() = on.then(Default::default);
    }

    /// Calls `f` with the text (the message and the stack) of every error
    /// of the app, which is also logged: [`AppView::on_app_error`] with
    /// [`AppError`]'s text, replacing the handler either set. A dev
    /// session ([`AppView::connect_dev_server`]) shows them too.
    pub fn on_error(&self, f: impl Fn(&str) + 'static) {
        self.on_app_error(move |error| f(&error.to_string()));
    }

    /// Calls `f` with every error of the app, which is also logged: what
    /// went wrong ([`AppError::kind`]; [`AppError::is_fatal`] when the app
    /// did not start or its VM stopped, so that no JS of it runs again),
    /// the message, the stack mapped to the app's sources, and the signed
    /// package it came from ([`AppError::package`]: its id and build).
    /// Replaces the handler [`AppView::on_error`] or this set.
    pub fn on_app_error(&self, f: impl Fn(&AppError) + 'static) {
        self.surface.set_error_handler(Box::new(f));
    }

    pub(crate) fn surface(&self) -> &Rc<Surface> {
        &self.surface
    }

    /// Tab: the surface's next text field; past its last one, the window's
    /// next tab stop (the embedding app's widgets), or the first field again
    /// when there is none.
    /// Files dragged in from outside the window (Finder, the desktop) and
    /// dropped: GPUI turns the drop into a mouse up carrying them, which
    /// only its own elements hear (`render`'s drop layer).
    fn drop_files(&mut self, paths: &gpui::ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let uris: Vec<String> = paths
            .paths()
            .iter()
            .filter(|path| path.is_absolute())
            .map(|path| nsh_core::platform::clipboard::file_url(&path.to_string_lossy()))
            .collect();
        if uris.is_empty() {
            return;
        }
        let (ox, oy) = self.surface.origin.get();
        let position = window.mouse_position();
        let (x, y) = (f32::from(position.x) - ox, f32::from(position.y) - oy);
        if crate::input::file_drop(&self.surface, x, y, uris) {
            crate::rt::flush(cx);
        }
    }

    fn focus_next(&mut self, _: &FocusNext, window: &mut Window, cx: &mut Context<Self>) {
        self.tab(false, window, cx);
    }

    /// Shift + Tab, the other way.
    fn focus_prev(&mut self, _: &FocusPrev, window: &mut Window, cx: &mut Context<Self>) {
        self.tab(true, window, cx);
    }

    /// After every keystroke: when Tab (handled by the host, GPUI Kit's
    /// `Root`) moved the window's focus onto the view, the focus goes on to
    /// its first text field (its last with Shift), not to the view itself.
    fn tab_entered(
        &mut self,
        event: &gpui::KeystrokeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let k = &event.keystroke;
        let m = &k.modifiers;
        if k.key != "tab" || m.control || m.alt || m.platform || self.tabbed.take() {
            return;
        }
        // The host's Tab lands on the view, or (by GPUI's tab order, which
        // does not follow the surface's tree) on one of its components.
        let on_view = self.focus.is_focused(window)
            && crate::text_input::focused_view(&self.surface).is_none();
        if !on_view && !crate::native::focused(&self.surface, window) {
            return;
        }
        crate::input::tab_to_edge(&self.surface, m.shift);
        crate::native::apply_focus(&self.surface, &self.focus, window, cx);
        crate::rt::flush(cx);
    }

    fn tab(&self, shift: bool, window: &mut Window, cx: &mut Context<Self>) {
        let event = crate::input::KeyEvent {
            vk: crate::keys::VK_TAB,
            down: true,
            repeat: false,
            modifiers: crate::input::Modifiers {
                shift,
                ..Default::default()
            },
        };
        self.tabbed.set(true);
        if !crate::input::key(&self.surface, event) {
            // Past the last stop (the first with Shift): on to the window's
            // next tab stop outside the view, or around again when there is
            // none (a window of its own).
            if self.leave(shift, window, cx) || !crate::input::tab_to_edge(&self.surface, shift) {
                crate::text_input::blur_all(&self.surface);
            }
        }
        // A component Tab reached takes the window's focus; a field reached
        // from a component gives it back to the view.
        crate::native::apply_focus(&self.surface, &self.focus, window, cx);
        crate::rt::flush(cx);
    }
}

impl AppView {
    /// Moves the window's focus to the next tab stop (the previous with
    /// `shift`) outside the view, counted from the view's own: GPUI's tab
    /// order also holds the components' handles, inserted wherever the
    /// surface prepaints them, and they are skipped. False when there is
    /// none: the focus is left on the view.
    fn leave(&self, shift: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        window.focus(&self.focus, cx);
        // Each component's handle at most once, the view's, then out.
        let tries = crate::native::component_count(&self.surface) + 2;
        for _ in 0..tries {
            if shift {
                window.focus_prev(cx);
            } else {
                window.focus_next(cx);
            }
            let inside =
                self.focus.is_focused(window) || crate::native::focused(&self.surface, window);
            if !inside {
                return true;
            }
            if self.focus.is_focused(window) {
                // Back at the view: no stop outside it.
                break;
            }
        }
        window.focus(&self.focus, cx);
        false
    }
}

impl Drop for AppView {
    fn drop(&mut self) {
        self.surface.stop();
    }
}

impl Focusable for AppView {
    fn focus_handle(&self, _cx: &GpuiApp) -> FocusHandle {
        self.focus.clone()
    }
}

/// The surface's window input handler resolves the current native field for
/// every text operation, including focus changes between paints.
impl gpui::EntityInputHandler for AppView {
    fn text_input_target(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<gpui::TextInputTarget> {
        crate::text_input::ime::target(&self.surface)
    }

    fn accepts_text_input(&self, window: &mut Window, _cx: &mut Context<Self>) -> bool {
        window.is_window_active()
            && self.focus.is_focused(window)
            && crate::text_input::wants_text(&self.surface)
    }

    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        crate::text_input::ime::text_for_range(&self.surface, range, adjusted)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<gpui::UTF16Selection> {
        crate::text_input::ime::selected_text_range(&self.surface)
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        crate::text_input::ime::marked_text_range(&self.surface)
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        crate::text_input::ime::unmark_text(&self.surface);
        crate::rt::flush(cx);
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<std::ops::Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        crate::text_input::ime::replace_text_in_range(&self.surface, range, text);
        crate::rt::flush(cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<std::ops::Range<usize>>,
        text: &str,
        selected: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        crate::text_input::ime::replace_and_mark_text_in_range(
            &self.surface,
            range,
            text,
            selected,
        );
        crate::rt::flush(cx);
    }

    fn bounds_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        _element_bounds: gpui::Bounds<gpui::Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<gpui::Bounds<gpui::Pixels>> {
        crate::text_input::ime::bounds_for_range(&self.surface, range)
    }

    fn character_index_for_point(
        &mut self,
        point: gpui::Point<gpui::Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        crate::text_input::ime::character_index_for_point(&self.surface, point)
    }

    fn set_selected_text_range(
        &mut self,
        range: std::ops::Range<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        crate::text_input::ime::set_selected_text_range(&self.surface, range);
        crate::rt::flush(cx);
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        crate::text_input::ime::text_length_utf16(&self.surface)
    }

    fn text_input_configuration(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> gpui::TextInputConfiguration {
        crate::text_input::ime::configuration(&self.surface)
    }
}

impl Render for AppView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let surface = SurfaceElement {
            surface: self.surface.clone(),
            focus: self.focus.clone(),
            view: cx.entity().downgrade(),
        };
        // A dev session draws its status line and error overlay above.
        #[cfg(feature = "dev")]
        let surface = crate::dev::wrap(self, surface.into_any_element(), cx);
        // The window's chrome (title bar, menu bar) goes around the surface.
        let content = crate::chrome::render(&self.surface, surface, window, cx);
        // The div registers the view's tab stop, which only GPUI's own
        // elements can.
        gpui::div()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_prev))
            .size_full()
            .child(content)
            // While something is dragged, a layer over the surface takes the
            // drop: the surface's hitbox blocks the mouse for the elements
            // behind it, this div included.
            .when(cx.has_active_drag(), |div| {
                div.child(
                    gpui::div()
                        .absolute()
                        .inset_0()
                        .on_drop(cx.listener(Self::drop_files)),
                )
            })
    }
}

fn initial_environment() -> Environment {
    Environment {
        window: nsh_core::Size::default(),
        color_scheme: ColorScheme::Light,
        os: if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        },
        idiom: Idiom::Desktop,
        ..Environment::default()
    }
}

/// Opens a window showing `source` in an [`AppView`] (in a running GPUI
/// app).
pub fn open_app_window(
    source: AppSource,
    options: AppOptions,
    cx: &mut GpuiApp,
) -> anyhow::Result<gpui::WindowHandle<AppView>> {
    let size = gpui::size(
        gpui::px(options.size.0 as f32),
        gpui::px(options.size.1 as f32),
    );
    let bounds = gpui::Bounds::centered(None, size, cx);
    let window_options = gpui::WindowOptions {
        window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
        titlebar: Some(crate::titlebar_options(&options.title)),
        app_id: Some(options.app_id.clone()),
        // Linux: the window manager's decorations until the app hides the
        // title bar (`crate::chrome`).
        window_decorations: Some(gpui::WindowDecorations::Server),
        // GPUI draws unfocused windows at 30 fps by default: animations
        // run at the display's rate wherever the keyboard is, as in the
        // other backends.
        inactive_frame_interval: None,
        ..Default::default()
    };
    let handle = cx.open_window(window_options, move |window, cx| {
        let view: Entity<AppView> = cx.new(|cx| AppView::new(options, window, cx));
        view.read(cx).own_window(window, cx);
        match source {
            AppSource::Rust(root) => view.read(cx).load(App::Rust(root)),
            AppSource::Bundle(bundle) => view.read(cx).load(App::Js(bundle)),
            #[cfg(feature = "dev")]
            AppSource::DevServer(url) => {
                view.update(cx, |view, cx| view.connect_dev_server(url, cx))
            }
        }
        let focus = view.read(cx).focus.clone();
        window.focus(&focus, cx);
        view
    })?;
    Ok(handle)
}

/// Runs `source` in a window until it is closed. Fails when the window
/// cannot open.
pub fn run_app(source: AppSource, options: AppOptions) -> std::process::ExitCode {
    let ok = Rc::new(std::cell::Cell::new(true));
    let result = ok.clone();
    gpui_platform::application().run(move |cx| {
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        if let Err(err) = open_app_window(source, options, cx) {
            log::error!("cannot open a window: {err}");
            ok.set(false);
            cx.quit();
            return;
        }
        cx.activate(true);
    });
    if result.get() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
