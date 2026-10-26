//! [`AppView`]: a view that runs a nsh app, for standalone apps and for
//! embedding in existing ones.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};

use nsh_engine::{App, Bundle, Root};
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
use objc2_core_foundation::CGRect;
use objc2_ui_kit::{UIView, UIViewAutoresizing};

use crate::surface::{Surface, SurfaceOptions};

/// A UIKit view running a nsh app.
///
/// Add [`AppView::view`] to any hierarchy, then [`AppView::run`] a Rust
/// app's root component or [`AppView::load`] a JS bundle (or, in
/// development builds, [`AppView::connect_dev_server`]). Loading again
/// replaces the running app. Dropping the `AppView` stops the app.
pub struct AppView {
    inner: Rc<Inner>,
}

pub(crate) struct Inner {
    /// Hosts the surface and, in development, overlays above it.
    pub(crate) container: Retained<UIView>,
    state: RefCell<State>,
}

/// Receives fatal app errors.
type ErrorHandler = Rc<dyn Fn(&str)>;

struct State {
    surface: Option<Surface>,
    options: SurfaceOptions,
    /// The embedding app's locale and text size.
    host: nsh_engine::HostEnvironment,
    /// The embedding app's theme overrides.
    host_tokens: Option<nsh_engine::Tokens>,
    on_error: Option<ErrorHandler>,
    #[cfg(feature = "dev")]
    dev: Option<crate::dev::DevSession>,
    /// A test session's model of the app, for every surface from now on.
    #[cfg(feature = "dev")]
    test_model: Option<std::sync::Arc<nsh_testing::agent::Model>>,
}

impl AppView {
    /// Creates an empty view; it resizes with its superview.
    pub fn new(mtm: MainThreadMarker, frame: CGRect, options: SurfaceOptions) -> AppView {
        let container = UIView::initWithFrame(UIView::alloc(mtm), frame);
        container.setAutoresizingMask(
            UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
        );
        AppView {
            inner: Rc::new(Inner {
                container,
                state: RefCell::new(State {
                    surface: None,
                    options,
                    host: nsh_engine::HostEnvironment::default(),
                    host_tokens: None,
                    on_error: None,
                    #[cfg(feature = "dev")]
                    dev: None,
                    #[cfg(feature = "dev")]
                    test_model: None,
                }),
            }),
        }
    }

    /// The view to add to a hierarchy.
    pub fn view(&self) -> &UIView {
        &self.inner.container
    }

    /// Runs `bundle`, replacing the running app (its state is reset).
    pub fn load(&self, bundle: Bundle) {
        Inner::load(&self.inner, App::Js(bundle));
    }

    /// Runs a Rust app: its root component (`Root::of::<App>()`), replacing
    /// the running app.
    pub fn run(&self, root: Root) {
        Inner::load(&self.inner, App::Rust(root));
    }

    /// Sets where `asset:/…` files (images, fonts) are read from. A change
    /// applies from the next [`AppView::load`].
    pub fn set_asset_base(&self, base: Option<crate::AssetBase>) {
        let mut state = self.inner.state.borrow_mut();
        let changed = match (&state.options.asset_base, &base) {
            (None, None) => false,
            (Some(crate::AssetBase::Http(a)), Some(crate::AssetBase::Http(b))) => a != b,
            (Some(crate::AssetBase::Directory(a)), Some(crate::AssetBase::Directory(b))) => a != b,
            _ => true,
        };
        if changed {
            state.options.asset_base = base;
            // The next load starts a surface with the new location.
            if let Some(old) = state.surface.take() {
                old.view().removeFromSuperview();
            }
        }
    }

    /// What the apps this view loads are granted at most (`None`: what each
    /// app declares). Applies from the next [`AppView::load`].
    pub fn set_granted_capabilities(&self, granted: Option<nsh_engine::Capabilities>) {
        self.reconfigure(|options| options.granted = granted);
    }

    /// Registers native component `name` (`nativeComponent(name, ...)` in
    /// JS): `factory` makes one for every element. Applies to elements
    /// created from now on.
    pub fn register_component(&self, name: &str, factory: crate::ComponentFactory) {
        self.inner
            .state
            .borrow()
            .options
            .components
            .register(name, factory);
    }

    /// The channel with the apps this view runs (`nsh/host`): their
    /// launch parameters ([`nsh_engine::HostChannel::set_params`], read when
    /// an app starts), events to them ([`nsh_engine::HostChannel::send`])
    /// and handlers of their calls and posts
    /// ([`nsh_engine::HostChannel::handle`], run on the engine thread). One
    /// channel for every app the view loads.
    pub fn host(&self) -> nsh_engine::HostChannel {
        self.inner.state.borrow().options.host.clone()
    }

    /// The VM limits of the apps this view loads. Applies from the next
    /// [`AppView::load`].
    pub fn set_limits(&self, limits: nsh_engine::Limits) {
        self.inner.set_limits(limits);
    }

    /// Where the apps this view loads keep their caches (the images they
    /// downloaded) and how much each keeps ([`SurfaceOptions::cache`]). A
    /// change applies from the next [`AppView::load`].
    pub fn set_cache(&self, cache: nsh_engine::CacheOptions) {
        if self.inner.state.borrow().options.cache != cache {
            self.reconfigure(|options| options.cache = cache);
        }
    }

    /// The directory the storage (`nsh/storage`) of the apps this view loads
    /// is kept in (`storage.json` in it), overriding each app's own in
    /// [`SurfaceOptions::data_dir`] (`None`: theirs). A change applies from
    /// the next [`AppView::load`].
    pub fn set_storage_directory(&self, dir: Option<std::path::PathBuf>) {
        if self.inner.state.borrow().options.storage != dir {
            self.reconfigure(|options| options.storage = dir);
        }
    }

    /// The embedding app's locale, which stands in for the user's: what
    /// `Intl` formats for by default and what `locale()` (`nsh/device`) and
    /// Rust components' `locale()` read, at once and for every app loaded
    /// later. `None` follows the system's again.
    pub fn set_locale(&self, locale: Option<nsh_engine::Locale>) {
        self.set_host(|host| host.locale = locale);
    }

    /// The embedding app's text size relative to the default (1.0), which
    /// stands in for Dynamic Type's: every text that allows font scaling is
    /// laid out again at it, and `fontScale()` reads it, at once and for
    /// every app loaded later. Lengths stay as they are (spacing, sizes,
    /// radii): boxes sized by their text grow with it. `None` follows the
    /// system's again.
    pub fn set_font_scale(&self, scale: Option<f32>) {
        self.set_host(|host| host.font_scale = scale);
    }

    /// The embedding app's theme overrides: a theme file of shadcn/ui's
    /// (`{ "cssVars": { "theme": { … }, "light": { … }, "dark": { … } } }`,
    /// values as CSS writes them, as `nsh.json`'s `"theme"`), whose
    /// tokens win over the app's of the same names, light and dark, while
    /// the app's others stay (a brand's `primary` and `radius`). Classes
    /// naming them (`bg-primary`) are resolved again at once, and every
    /// app loaded later starts with them. `None` gives the app its own
    /// theme back. Fails, changing nothing, on a file that does not parse.
    pub fn set_theme_overrides(&self, json: Option<&str>) -> Result<(), nsh_base::ThemeError> {
        let tokens = json.map(nsh_base::theme_overrides).transpose()?;
        let mut state = self.inner.state.borrow_mut();
        state.host_tokens = tokens;
        if let Some(surface) = &state.surface {
            surface.set_host_tokens(state.host_tokens.clone());
        }
        Ok(())
    }

    fn set_host(&self, change: impl FnOnce(&mut nsh_engine::HostEnvironment)) {
        let mut state = self.inner.state.borrow_mut();
        change(&mut state.host);
        if let Some(surface) = &state.surface {
            surface.set_host_environment(state.host);
        }
    }

    fn reconfigure(&self, change: impl FnOnce(&mut SurfaceOptions)) {
        self.inner.reconfigure(change);
    }

    /// Receives fatal app errors (bundle failed to load, uncaught JS
    /// exceptions) on the main thread. They are always logged; development
    /// builds also show them over the app.
    pub fn set_error_handler(&self, handler: impl Fn(&str) + 'static) {
        self.inner.state.borrow_mut().on_error = Some(Rc::new(handler));
    }

    /// Loads bundles from a `nsh dev` server (`ws://host:port/ws`) and
    /// reloads on every rebuild; build and runtime errors show over the app.
    #[cfg(feature = "dev")]
    pub fn connect_dev_server(&self, url: String) {
        // `ws://host:port/ws` -> assets at `http://host:port/assets/`.
        if let Some(rest) = url.strip_prefix("ws://")
            && let Some((host, _)) = rest.split_once('/')
        {
            self.inner.state.borrow_mut().options.asset_base =
                Some(crate::AssetBase::Http(format!("http://{host}/assets/")));
        }
        let session = crate::dev::DevSession::start(Rc::downgrade(&self.inner), url);
        self.inner.state.borrow_mut().dev = session;
    }
}

impl Inner {
    fn reconfigure(&self, change: impl FnOnce(&mut SurfaceOptions)) {
        let mut state = self.state.borrow_mut();
        change(&mut state.options);
        // The next load starts a surface with the new options.
        if let Some(old) = state.surface.take() {
            old.view().removeFromSuperview();
        }
    }

    /// The VM limits of the apps loaded from now on (a change starts the
    /// next load on a surface of its own).
    pub(crate) fn set_limits(&self, limits: nsh_engine::Limits) {
        if self.state.borrow().options.limits != limits {
            self.reconfigure(|options| options.limits = limits);
        }
    }

    pub(crate) fn load(this: &Rc<Inner>, app: App) {
        let mut state = this.state.borrow_mut();
        if let Some(surface) = &state.surface {
            return surface.reload(app);
        }
        let mtm = this.container.mtm();
        let options = state.options.clone();
        let surface = match Surface::new(mtm, app, this.container.bounds(), options) {
            Ok(surface) => surface,
            Err(err) => return log::error!("failed to start the engine: {err}"),
        };
        surface.view().setAutoresizingMask(
            UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
        );
        surface.set_host_environment(state.host);
        surface.set_host_tokens(state.host_tokens.clone());
        #[cfg(feature = "dev")]
        surface.set_test_model(state.test_model.clone());
        let weak: Weak<Inner> = Rc::downgrade(this);
        surface.set_error_handler(move |message| {
            if let Some(inner) = weak.upgrade() {
                inner.report_error(message);
            }
        });
        #[cfg(feature = "dev")]
        {
            let weak: Weak<Inner> = Rc::downgrade(this);
            surface.set_hot_failed_handler(move || {
                if let Some(inner) = weak.upgrade() {
                    crate::dev::DevSession::reload(&inner);
                }
            });
        }
        // Below development overlays.
        this.container.insertSubview_atIndex(surface.view(), 0);
        state.surface = Some(surface);
    }

    /// Applies a development update in place; false when no app runs.
    #[cfg(feature = "dev")]
    pub(crate) fn hot_update(&self, update: nsh_engine::HotUpdate) -> bool {
        self.state
            .borrow()
            .surface
            .as_ref()
            .is_some_and(|s| s.hot_update(update))
    }

    #[cfg(feature = "dev")]
    /// Keeps `model` of the app for `nsh test --target ios`, in the surface
    /// running now and those to come.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: std::sync::Arc<nsh_testing::agent::Model>) {
        let mut state = self.state.borrow_mut();
        if let Some(surface) = &state.surface {
            surface.set_test_model(Some(model.clone()));
        }
        state.test_model = Some(model);
    }

    /// `f` with the running app's mounter.
    #[cfg(feature = "dev")]
    pub(crate) fn with_mounter<R>(&self, f: impl FnOnce(&crate::mount::Mounter) -> R) -> Option<R> {
        self.state.borrow().surface.as_ref()?.with_mounter(f)
    }

    #[cfg(feature = "dev")]
    pub(crate) fn dev(&self) -> std::cell::Ref<'_, Option<crate::dev::DevSession>> {
        std::cell::Ref::map(self.state.borrow(), |s| &s.dev)
    }

    fn report_error(&self, message: &str) {
        let handler = self.state.borrow().on_error.clone();
        if let Some(handler) = handler {
            handler(message);
        }
        #[cfg(feature = "dev")]
        if let Some(dev) = &self.state.borrow().dev {
            dev.show_error(&self.container, "Uncaught error", message);
        }
    }
}
