//! Web views: wry web views (feature `webview`), placed at their view's box
//! by every prepaint of the surface.
//!
//! wry builds a web view as a child of a window, which needs GPUI's
//! window: a web view is made in the first prepaint after its props came
//! ([`WebItem::prepaint`]), and props and commands wait for it. Settings
//! wry only takes when it builds (the injected scripts, the user agent,
//! `javascriptEnabled`) make it anew when they change; a new source loads
//! in the same one.
//!
//! - **Linux**: WebKitGTK 4.1 on GTK 3, which only embeds into X11
//!   windows: GPUI must run on X11 (or Xwayland). GTK is started on its X11
//!   backend once and its main loop pumped from GPUI's. Each web view lives
//!   in a GPUI Fast native composition surface (an X11 child window of
//!   GPUI's), sized to the visible part of its view so that clipping
//!   ancestors cut it, with the page inside it at the whole box; WebKit's
//!   zoom makes its CSS pixels GPUI's points. On a Wayland window a web
//!   view draws a neutral placeholder (logged once). Where WebKit's
//!   DMA-BUF renderer cannot allocate GBM buffers (some Xwayland setups:
//!   "Failed to create GBM buffer" in the log), pages stay black unless the
//!   app runs with `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
//! - **macOS, Windows**: wry's child view (`WKWebView`) or child window
//!   (WebView2), at the view's box, shown while any of it is visible
//!   (clipping ancestors do not cut it).
//!
//! The native view sits above everything GPUI draws at its place (nsh
//! content drawn over a web view is under it), takes its own input (a
//! hitbox blocks nsh's under it), and is absent from offscreen
//! screenshots.
//!
//! Pages talk to the app through `window.nsh`: the bridge script
//! defines `window.nsh.postMessage(data)` (`onMessage`), and
//! `postMessage()` dispatches a `message` event on the page's `window`.
//! Top-level navigations stay within the app's `webview` capability.
//! Events are the iOS ones: `onLoadStart` and `onNavigationStateChange`
//! when a page starts loading, `onLoad` and `onNavigationStateChange` when
//! it finished, `onError` when a navigation is refused (and, on Linux, when
//! it fails). `canGoBack` / `canGoForward` come from the page's Navigation
//! API (false where the engine lacks it).
//!
//! Not supported: `baseUrl` for HTML, `scrollable` and
//! `allowsBackForwardNavigationGestures`; failed loads report no `onError`
//! on macOS and Windows.

#[cfg(feature = "webview")]
pub(crate) use imp::WebItem;
#[cfg(not(feature = "webview"))]
pub(crate) use placeholder::WebItem;

/// Lets pages talk to the app: `window.nsh.postMessage(data)`.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
const BRIDGE: &str = "window.nsh = window.nsh || { postMessage: function (data) { window.ipc.postMessage(String(data)); } };";

/// The page's navigation state, as a JSON array `[url, title, canGoBack,
/// canGoForward]`.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
const STATE: &str = "[location.href, document.title, !!(window.navigation && navigation.canGoBack), !!(window.navigation && navigation.canGoForward)]";

/// A JS string literal for `s`.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The script `postMessage(data)` runs in the page.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
fn post_message(data: &str) -> String {
    format!(
        "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
        js_string(data)
    )
}

/// `injectedJavaScript`: once the document is parsed.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
fn after_content(js: &str) -> String {
    format!(
        "(function () {{ var run = function () {{\n{js}\n}}; \
         if (document.readyState === 'loading') {{ document.addEventListener('DOMContentLoaded', run, {{ once: true }}); }} \
         else {{ run(); }} }})();"
    )
}

/// The page's navigation state, as `WebViewNavigation`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
struct Navigation {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[cfg_attr(not(feature = "webview"), allow(dead_code))]
impl Navigation {
    /// The state [`STATE`] evaluated to (`json`), `loading` or not.
    fn parse(json: &str, loading: bool) -> Option<Navigation> {
        let v: serde_json::Value = serde_json::from_str(json).ok()?;
        let a = v.as_array()?;
        let s = |i: usize| a.get(i).and_then(|v| v.as_str()).unwrap_or("").to_owned();
        let b = |i: usize| a.get(i).and_then(|v| v.as_bool()).unwrap_or(false);
        Some(Navigation {
            url: s(0),
            title: s(1),
            loading,
            can_go_back: b(2),
            can_go_forward: b(3),
        })
    }

    fn payload(&self) -> nsh_core::EventPayload {
        use nsh_core::{EventPayload, PayloadValue};
        EventPayload::Map(vec![
            ("url", PayloadValue::Str(self.url.clone())),
            ("title", PayloadValue::Str(self.title.clone())),
            ("loading", PayloadValue::Bool(self.loading)),
            ("canGoBack", PayloadValue::Bool(self.can_go_back)),
            ("canGoForward", PayloadValue::Bool(self.can_go_forward)),
        ])
    }
}

/// True for URLs a web view shows whatever the app's access: pages the app
/// gave as HTML.
#[cfg_attr(not(feature = "webview"), allow(dead_code))]
fn always_allowed(url: &str) -> bool {
    url.starts_with("data:") || url.starts_with("about:")
}

#[cfg(not(feature = "webview"))]
mod placeholder {
    use std::rc::Rc;

    use gpui::{App, Window};
    use nsh_core::{Command, NodeId, WebProps};

    use crate::{
        native::Geometry,
        render::DrawCx,
        surface::Surface,
        view::{Hosted, NshView},
    };

    /// A web view in a build without them: a placeholder.
    pub(crate) struct WebItem;

    impl WebItem {
        pub(crate) fn new(_surface: &Rc<Surface>, _id: NodeId) -> Rc<Self> {
            Rc::new(WebItem)
        }
        pub(crate) fn set(&self, _surface: &Rc<Surface>, _view: &NshView, _p: &WebProps) {}
        pub(crate) fn command(&self, _command: &Command) {}
        pub(crate) fn prepaint(
            &self,
            _surface: &Rc<Surface>,
            _view: &NshView,
            _geometry: Option<Geometry>,
            _window: &mut Window,
            _cx: &mut App,
        ) {
        }
        pub(crate) fn close(&self) {}
    }

    impl Hosted for WebItem {
        fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
            crate::native::placeholder(cx, size, "WebView is not available in this build");
        }

        fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
            false
        }
    }
}

#[cfg(feature = "webview")]
mod imp {
    use std::{
        cell::{Cell, RefCell},
        rc::{Rc, Weak},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use gpui::{App, Bounds, ContentMask, HitboxBehavior, Pixels, Window};
    use nsh_core::{Command, EventKind, EventPayload, NodeId, PayloadValue, WebProps, WebSource};

    use super::{BRIDGE, Navigation, STATE, after_content, always_allowed, post_message};
    use crate::{
        native::{Emitter, Geometry, Host, error},
        render::DrawCx,
        surface::Surface,
        view::{Hosted, NshView},
    };

    /// What wry only takes when it builds a web view.
    #[derive(Clone, PartialEq)]
    struct BuildKey {
        injected_js: Option<Arc<str>>,
        injected_js_before: Option<Arc<str>>,
        user_agent: Option<Arc<str>>,
        javascript_enabled: bool,
    }

    impl BuildKey {
        fn of(p: &WebProps) -> Self {
            BuildKey {
                injected_js: p.injected_js.clone(),
                injected_js_before: p.injected_js_before.clone(),
                user_agent: p.user_agent.clone(),
                javascript_enabled: p.javascript_enabled,
            }
        }
    }

    /// A web view wry built.
    struct Built {
        webview: Rc<wry::WebView>,
        key: BuildKey,
        /// The source it shows.
        source: WebSource,
        /// Its composition surface (Linux).
        #[cfg(target_os = "linux")]
        surface: Option<linux::NativeSurface>,
        /// The geometry applied, `None` while hidden.
        shown: Cell<Option<Geometry>>,
    }

    impl Drop for Built {
        fn drop(&mut self) {
            let _ = self.webview.set_visible(false);
            #[cfg(target_os = "linux")]
            {
                if let Some(surface) = self.surface.take() {
                    surface.release(self.webview.clone());
                }
                linux::gone();
            }
        }
    }

    /// A web view: its props and, once built, its wry web view.
    pub(crate) struct WebItem {
        emitter: Emitter,
        surface: Weak<Surface>,
        id: NodeId,
        /// The props asked for.
        props: RefCell<Option<WebProps>>,
        built: RefCell<Option<Built>>,
        /// Commands that came before the web view was built.
        queued: RefCell<Vec<Command>>,
        /// Why no web view can be made (drawn as a placeholder).
        failed: Cell<Option<&'static str>>,
        /// The view's background (the page's until it paints).
        background: Cell<nsh_core::Color>,
        /// Where the last prepaint found the view.
        geometry: Cell<Option<Geometry>>,
        /// The scale the page's zoom was matched to.
        scale: Cell<f32>,
        /// The page's navigation state as last reported.
        nav: RefCell<Navigation>,
    }

    impl WebItem {
        pub(crate) fn new(surface: &Rc<Surface>, id: NodeId) -> Rc<Self> {
            Rc::new(WebItem {
                emitter: Emitter::new(surface, id),
                surface: Rc::downgrade(surface),
                id,
                props: RefCell::new(None),
                built: RefCell::new(None),
                queued: RefCell::new(Vec::new()),
                failed: Cell::new(None),
                background: Cell::new(nsh_core::Color::TRANSPARENT),
                geometry: Cell::new(None),
                scale: Cell::new(0.0),
                nav: RefCell::default(),
            })
        }

        /// New props: applied now, or by the prepaint that builds the web
        /// view.
        pub(crate) fn set(&self, surface: &Rc<Surface>, view: &NshView, p: &WebProps) {
            self.background.set(view.state().style.background_color);
            *self.props.borrow_mut() = Some(p.clone());
            let rebuild = self
                .built
                .borrow()
                .as_ref()
                .is_some_and(|b| b.key != BuildKey::of(p));
            if rebuild {
                // Made anew by the next prepaint.
                self.built.borrow_mut().take();
            } else {
                self.load(p);
            }
            surface.invalidate();
        }

        /// Loads `p`'s source if the built web view shows another.
        fn load(&self, p: &WebProps) {
            let webview = {
                let mut built = self.built.borrow_mut();
                let Some(built) = built.as_mut() else { return };
                if built.source == p.source {
                    return;
                }
                built.source = p.source.clone();
                built.webview.clone()
            };
            let result = match &p.source {
                WebSource::Uri(uri) => webview.load_url(uri),
                WebSource::Html { html, base_url } => {
                    warn_base_url(base_url.is_some());
                    webview.load_html(html)
                }
                WebSource::None => webview.load_url("about:blank"),
            };
            if let Err(err) = result {
                let message = err.to_string();
                self.emitter.emit(EventKind::Error, || error(message));
            }
        }

        /// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
        /// `injectJavaScript()` and `postMessage()`.
        pub(crate) fn command(&self, command: &Command) {
            let webview = self.built.borrow().as_ref().map(|b| b.webview.clone());
            let Some(webview) = webview else {
                if self.failed.get().is_none() {
                    self.queued.borrow_mut().push(command.clone());
                }
                return;
            };
            let result = match command {
                Command::Reload => webview.reload(),
                Command::GoBack => webview.evaluate_script("history.back();"),
                Command::GoForward => webview.evaluate_script("history.forward();"),
                Command::StopLoading => webview.evaluate_script("window.stop();"),
                Command::InjectJavaScript(js) => webview.evaluate_script(js),
                Command::PostMessage(data) => webview.evaluate_script(&post_message(data)),
                _ => Ok(()),
            };
            if let Err(err) = result {
                log::warn!(target: "js", "web view: {err}");
            }
        }

        /// The surface's prepaint: builds the web view if it waits for
        /// one, and moves it to `geometry` over a hitbox that keeps nsh's
        /// input away.
        pub(crate) fn prepaint(
            self: &Rc<Self>,
            _surface: &Rc<Surface>,
            _view: &NshView,
            geometry: Option<Geometry>,
            window: &mut Window,
            cx: &mut App,
        ) {
            self.geometry.set(geometry);
            if self.built.borrow().is_none() && self.failed.get().is_none() {
                let props = self.props.borrow().clone();
                if let Some(props) = props {
                    self.build(&props, window, cx);
                }
            }
            let built = self.built.borrow();
            let Some(built) = &*built else { return };
            #[cfg(target_os = "linux")]
            {
                let scale = window.scale_factor();
                if self.scale.replace(scale) != scale {
                    linux::match_scale(&built.webview, scale);
                }
            }
            let Some(g) = geometry.filter(Geometry::shows) else {
                return;
            };
            let mask = ContentMask { bounds: g.visible };
            window.with_content_mask(Some(mask), |window| {
                window.insert_hitbox(g.visible, HitboxBehavior::BlockMouse);
            });
            if built.shown.get() != Some(g) {
                let scale = window.scale_factor();
                if let Err(err) = place(built, g, scale) {
                    log::warn!("web view: cannot place it: {err:#}");
                }
            }
        }

        /// Builds the web view for `p` in `window`.
        fn build(self: &Rc<Self>, p: &WebProps, window: &mut Window, cx: &mut App) {
            let key = BuildKey::of(p);
            let mut builder = wry::WebViewBuilder::new()
                .with_visible(false)
                .with_initialization_script_for_main_only(BRIDGE, true);
            if let Some(js) = &p.injected_js_before {
                builder = builder.with_initialization_script_for_main_only(&**js, true);
            }
            if let Some(js) = &p.injected_js {
                builder = builder.with_initialization_script_for_main_only(after_content(js), true);
            }
            if let Some(agent) = &p.user_agent {
                builder = builder.with_user_agent(&**agent);
            }
            if !p.javascript_enabled {
                builder = builder.with_javascript_disabled();
            }
            let background = self.background.get();
            if background.0 & 0xff == 0xff {
                let (r, g, b, _) = background.to_f64();
                let c = |v: f64| (v * 255.0).round() as u8;
                builder = builder.with_background_color((c(r), c(g), c(b), 255));
            }
            builder = match &p.source {
                WebSource::Uri(uri) => builder.with_url(&**uri),
                WebSource::Html { html, base_url } => {
                    warn_base_url(base_url.is_some());
                    builder.with_html(&**html)
                }
                WebSource::None => builder.with_url("about:blank"),
            };
            builder = self.listen(builder);

            #[cfg(target_os = "linux")]
            let made = linux::build(builder, window, cx);
            #[cfg(not(target_os = "linux"))]
            let made = {
                let _ = cx;
                builder
                    .build_as_child(&*window)
                    .map(|w| (w, ()))
                    .map_err(|e| (e.to_string(), "WebView could not be made"))
            };
            match made {
                Ok((webview, _native)) => {
                    #[cfg(target_os = "linux")]
                    linux::made();
                    #[cfg(target_os = "linux")]
                    linux::report_failures(&webview, self.emitter.clone());
                    *self.built.borrow_mut() = Some(Built {
                        webview: Rc::new(webview),
                        key,
                        source: p.source.clone(),
                        #[cfg(target_os = "linux")]
                        surface: _native,
                        shown: Cell::new(None),
                    });
                    self.scale.set(0.0);
                    // Once GTK realized it (its loop runs every 16 ms).
                    let item = Rc::downgrade(self);
                    crate::rt::after_ms(100, move || {
                        if let Some(item) = item.upgrade()
                            && let Some(surface) = item.surface.upgrade()
                        {
                            item.settle(&surface);
                        }
                    });
                    let queued = std::mem::take(&mut *self.queued.borrow_mut());
                    for command in &queued {
                        self.command(command);
                    }
                }
                Err((why, shown)) => {
                    static WARNED: AtomicBool = AtomicBool::new(false);
                    if !WARNED.swap(true, Ordering::Relaxed) {
                        log::warn!(target: "js", "web views cannot show: {why}");
                    }
                    self.failed.set(Some(shown));
                    self.queued.borrow_mut().clear();
                }
            }
        }

        /// Reports the web view's navigations, loads and messages.
        fn listen<'a>(
            self: &Rc<Self>,
            builder: wry::WebViewBuilder<'a>,
        ) -> wry::WebViewBuilder<'a> {
            let emitter = self.emitter.clone();
            let surface = self.surface.clone();
            let builder = builder.with_navigation_handler(move |url| {
                if always_allowed(&url) {
                    return true;
                }
                let access = surface
                    .upgrade()
                    .and_then(|s| s.native.access.borrow().clone());
                if access.is_none_or(|a| a.allows_webview(&url)) {
                    return true;
                }
                log::warn!(target: "js", "web view navigation to {url} is not granted");
                let message = format!("navigation to {url} is not granted");
                emitter.emit(EventKind::Error, || {
                    EventPayload::Map(vec![
                        ("message", PayloadValue::Str(message)),
                        (
                            "code",
                            PayloadValue::Str(nsh_core::element::codes::ACCESS_DENIED.into()),
                        ),
                        ("url", PayloadValue::Str(url.clone())),
                    ])
                });
                false
            });
            let emitter = self.emitter.clone();
            let builder = builder.with_ipc_handler(move |request| {
                let data = request.body().clone();
                emitter.emit(EventKind::Message, || {
                    EventPayload::Map(vec![("data", PayloadValue::Str(data))])
                });
            });
            let item = Rc::downgrade(self);
            let builder = builder.with_document_title_changed_handler(move |title| {
                if let Some(item) = item.upgrade() {
                    item.nav.borrow_mut().title = title;
                }
            });
            let item = Rc::downgrade(self);
            builder.with_on_page_load_handler(move |event, url| {
                let Some(item) = item.upgrade() else { return };
                match event {
                    wry::PageLoadEvent::Started => {
                        let state = {
                            let mut nav = item.nav.borrow_mut();
                            nav.url = url;
                            nav.loading = true;
                            nav.clone()
                        };
                        item.emitter.emit(EventKind::LoadStart, || state.payload());
                        item.emitter
                            .emit(EventKind::NavigationStateChange, || state.payload());
                    }
                    wry::PageLoadEvent::Finished => item.finished(url),
                }
            })
        }

        /// A page finished loading: asks it for its state, then reports
        /// `onLoad`.
        fn finished(&self, url: String) {
            let webview = self.built.borrow().as_ref().map(|b| b.webview.clone());
            let Some(surface) = self.surface.upgrade() else {
                return;
            };
            let (key, id) = (surface.key(), self.id);
            self.settle(&surface);
            // Reported at once, with what is known: the page's answer
            // below may never come (WebKit drops scripts of a page that is
            // replaced or still busy).
            let state = {
                let mut nav = self.nav.borrow_mut();
                nav.url = url;
                nav.loading = false;
                nav.clone()
            };
            self.emitter.emit(EventKind::Load, || state.payload());
            self.emitter
                .emit(EventKind::NavigationStateChange, || state.payload());
            // Then its title and history, when they differ.
            let Some(webview) = webview else { return };
            let asked = webview.evaluate_script_with_callback(STATE, move |json| {
                crate::rt::invoke(move || {
                    let Some(surface) = Surface::by_key(key) else {
                        return;
                    };
                    let item = match surface.native.hosts.borrow().get(&id) {
                        Some(Host::Web(item)) => item.clone(),
                        _ => return,
                    };
                    if let Some(state) = Navigation::parse(&json, false) {
                        item.answered(state);
                    }
                });
            });
            if let Err(err) = asked {
                log::debug!("web view: cannot read the page's state: {err}");
            }
        }

        /// The page told its state after it loaded: reported when it
        /// changed (and no other load started meanwhile).
        fn answered(&self, state: Navigation) {
            let changed = {
                let mut nav = self.nav.borrow_mut();
                if nav.loading || *nav == state {
                    false
                } else {
                    *nav = state.clone();
                    true
                }
            };
            if changed {
                self.emitter
                    .emit(EventKind::NavigationStateChange, || state.payload());
            }
        }

        /// Places the web view again with the next frame: WebKitGTK drops
        /// the bounds it gets before its widget is realized (and a load
        /// may reset them), leaving the surface empty.
        fn settle(&self, surface: &Surface) {
            if let Some(built) = self.built.borrow().as_ref() {
                built.shown.set(None);
            }
            surface.invalidate();
        }

        pub(crate) fn close(&self) {
            self.built.borrow_mut().take();
            self.queued.borrow_mut().clear();
        }
    }

    impl Hosted for WebItem {
        fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
            if let Some(text) = self.failed.get() {
                crate::native::placeholder(cx, size, text);
            }
        }

        fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
            // The page takes its own input.
            false
        }

        fn placed(&self, rect: Option<Bounds<Pixels>>) {
            let built = self.built.borrow();
            let Some(built) = &*built else { return };
            let shows = rect.is_some() && self.geometry.get().is_some_and(|g| g.shows());
            if !shows
                && built.shown.take().is_some()
                && let Err(err) = hide(built)
            {
                log::warn!("web view: cannot hide it: {err:#}");
            }
        }
    }

    /// Shows `built` at `g`.
    fn place(built: &Built, g: Geometry, scale: f32) -> anyhow::Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(surface) = &built.surface {
            surface.place(&built.webview, g, scale)?;
            built.webview.set_visible(true)?;
            built.shown.set(Some(g));
            return Ok(());
        }
        let _ = scale;
        let d = g.document;
        built.webview.set_bounds(wry::Rect {
            position: wry::dpi::LogicalPosition::new(
                f64::from(f32::from(d.origin.x)),
                f64::from(f32::from(d.origin.y)),
            )
            .into(),
            size: wry::dpi::LogicalSize::new(
                f64::from(f32::from(d.size.width)),
                f64::from(f32::from(d.size.height)),
            )
            .into(),
        })?;
        built.webview.set_visible(true)?;
        built.shown.set(Some(g));
        Ok(())
    }

    fn hide(built: &Built) -> anyhow::Result<()> {
        built.webview.set_visible(false)?;
        #[cfg(target_os = "linux")]
        if let Some(surface) = &built.surface {
            surface.set_visible(false)?;
        }
        Ok(())
    }

    fn warn_base_url(has: bool) {
        static WARNED: AtomicBool = AtomicBool::new(false);
        if has && !WARNED.swap(true, Ordering::Relaxed) {
            log::warn!(
                target: "js",
                "WebView `baseUrl` is not supported by this backend: relative links do not resolve"
            );
        }
    }

    #[cfg(target_os = "linux")]
    mod linux {
        //! WebKitGTK in X11 child windows of GPUI's window.

        use std::{cell::Cell, rc::Rc, time::Duration};

        use gpui::{App, Bounds, DevicePixels, Window, point, size};
        use nsh_core::{EventKind, EventPayload, PayloadValue};
        use wry::{
            WebViewExtUnix as _,
            dpi::{PhysicalPosition, PhysicalSize},
            raw_window_handle::{
                HandleError, HasWindowHandle, RawWindowHandle, WindowHandle, XlibWindowHandle,
            },
        };

        use crate::native::{Emitter, Geometry};

        /// How long a web view's surface outlives the web view.
        const RELEASE_DELAY: Duration = Duration::from_millis(500);

        /// How often pending GTK events are dispatched between GPUI's.
        const GTK_POLL: Duration = Duration::from_millis(16);

        thread_local! {
            /// GTK's loop is pumped from GPUI's (GTK runs on this, the main,
            /// thread).
            static GTK: Cell<bool> = const { Cell::new(false) };
            /// The web views alive: the pump stops when the last goes.
            static LIVE: Cell<usize> = const { Cell::new(0) };
        }

        /// A web view was made.
        pub(super) fn made() {
            LIVE.set(LIVE.get() + 1);
        }

        /// A web view went (and its windows with it, which takes GTK's loop).
        pub(super) fn gone() {
            LIVE.set(LIVE.get().saturating_sub(1));
        }

        /// Starts GTK on its X11 backend once, pumping its main loop from
        /// GPUI's.
        fn ensure_gtk(cx: &mut App) -> Result<(), String> {
            if GTK.get() {
                return Ok(());
            }
            if !gtk::is_initialized_main_thread() {
                // wry downcasts the default GDK display to X11's.
                gtk::gdk::set_allowed_backends("x11");
                gtk::init().map_err(|e| format!("GTK did not start: {e}"))?;
            }
            GTK.set(true);
            cx.spawn(async move |cx| {
                loop {
                    while gtk::events_pending() {
                        gtk::main_iteration_do(false);
                    }
                    if LIVE.get() == 0 {
                        // Started again by the next web view.
                        GTK.set(false);
                        break;
                    }
                    cx.background_executor().timer(GTK_POLL).await;
                }
            })
            .detach();
            Ok(())
        }

        /// An X11 window as the Xlib parent wry wants (GPUI reports its X11
        /// windows through XCB).
        struct X11Parent(XlibWindowHandle);

        impl X11Parent {
            fn from_raw(handle: RawWindowHandle) -> Option<Self> {
                match handle {
                    RawWindowHandle::Xcb(handle) => {
                        let mut xlib = XlibWindowHandle::new(handle.window.get().into());
                        xlib.visual_id = handle.visual_id.map_or(0, |id| id.get().into());
                        Some(Self(xlib))
                    }
                    RawWindowHandle::Xlib(handle) => Some(Self(handle)),
                    _ => None,
                }
            }
        }

        impl HasWindowHandle for X11Parent {
            fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
                // SAFETY: the X11 window outlives the web view, which goes
                // before the composition surface (and with GPUI's window).
                Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Xlib(self.0)) })
            }
        }

        /// A web view and its composition surface.
        type Made = (wry::WebView, Option<NativeSurface>);

        /// Builds the web view in a composition surface of `window` (in
        /// `window` itself without composition). The error says why, and
        /// what the placeholder says.
        pub(super) fn build(
            builder: wry::WebViewBuilder<'_>,
            window: &mut Window,
            cx: &mut App,
        ) -> Result<Made, (String, &'static str)> {
            let handle = HasWindowHandle::window_handle(&*window)
                .map(|h| h.as_raw())
                .map_err(|e| (e.to_string(), "WebView is not available"))?;
            let Some(parent) = X11Parent::from_raw(handle) else {
                return Err((
                    "WebKitGTK only embeds into X11 windows; run the app on X11 or Xwayland \
                     (unset WAYLAND_DISPLAY)"
                        .to_owned(),
                    "WebView needs an X11 window",
                ));
            };
            ensure_gtk(cx).map_err(|e| (e, "WebView is not available"))?;
            let fail = |e: wry::Error| (e.to_string(), "WebView could not be made");
            match NativeSurface::new(window, cx) {
                Ok(surface) => {
                    let parent = surface
                        .parent()
                        .map_err(|e| (e, "WebView is not available"))?;
                    let webview = builder.build_as_child(&parent).map_err(fail)?;
                    Ok((webview, Some(surface)))
                }
                Err(err) => {
                    log::warn!("web view: no window composition ({err:#}): it is not clipped");
                    let webview = builder.build_as_child(&parent).map_err(fail)?;
                    Ok((webview, None))
                }
            }
        }

        /// Reports loads that fail with `onError` (refused navigations and
        /// replaced loads are not failures).
        pub(super) fn report_failures(webview: &wry::WebView, emitter: Emitter) {
            use webkit2gtk::{NetworkError, PolicyError, WebViewExt as _};
            webview
                .webview()
                .connect_load_failed(move |_, _, url, err| {
                    if err.matches(NetworkError::Cancelled)
                        || err.matches(PolicyError::FrameLoadInterruptedByPolicyChange)
                    {
                        return false;
                    }
                    let (message, url) = (err.to_string(), url.to_owned());
                    emitter.emit(EventKind::Error, || {
                        EventPayload::Map(vec![
                            ("message", PayloadValue::Str(message)),
                            ("url", PayloadValue::Str(url)),
                        ])
                    });
                    false
                });
        }

        /// Zooms the page so that its CSS pixels are GPUI's points (GDK's
        /// scale is an integer, GPUI's need not be).
        pub(super) fn match_scale(webview: &wry::WebView, scale: f32) {
            use gtk::prelude::WidgetExt as _;
            let gdk = webview.webview().scale_factor().max(1);
            let _ = webview.zoom(f64::from(scale) / f64::from(gdk));
        }

        /// A GPUI Fast composition surface holding a web view: an X11 child
        /// window of GPUI's.
        pub(super) struct NativeSurface {
            surface: gpui::WindowCompositionSurface,
            window: gpui::AnyWindowHandle,
            cx: gpui::AsyncApp,
        }

        impl NativeSurface {
            fn new(window: &Window, cx: &App) -> anyhow::Result<Self> {
                let surface = window
                    .enable_window_composition()?
                    .create_native_surface()?;
                Ok(NativeSurface {
                    surface,
                    window: window.window_handle(),
                    cx: cx.to_async(),
                })
            }

            /// Its X11 window, as the parent wry builds the web view in.
            fn parent(&self) -> Result<X11Parent, String> {
                let handle = self
                    .surface
                    .platform_surface()
                    .and_then(|s| s.platform_handle())
                    .map_err(|e| e.to_string())?;
                handle
                    .downcast::<RawWindowHandle>()
                    .ok()
                    .and_then(|h| X11Parent::from_raw(*h))
                    .ok_or_else(|| "the composition surface is not an X11 window".to_owned())
            }

            /// The surface over `g`'s visible part, the page at its whole
            /// box inside it.
            pub(super) fn place(
                &self,
                webview: &wry::WebView,
                g: Geometry,
                scale: f32,
            ) -> anyhow::Result<()> {
                let device = |v: gpui::Pixels| (f32::from(v) * scale).round() as i32;
                let v = g.visible;
                let platform = self.surface.platform_surface()?;
                platform.set_bounds(Bounds::new(
                    point(
                        DevicePixels(device(v.origin.x)),
                        DevicePixels(device(v.origin.y)),
                    ),
                    size(
                        DevicePixels(device(v.size.width)),
                        DevicePixels(device(v.size.height)),
                    ),
                ))?;
                // wry scales bounds by GDK's factor, not GPUI's: device
                // pixels.
                let d = g.document;
                webview.set_bounds(wry::Rect {
                    position: PhysicalPosition::new(
                        device(d.origin.x) - device(v.origin.x),
                        device(d.origin.y) - device(v.origin.y),
                    )
                    .into(),
                    size: PhysicalSize::new(device(d.size.width), device(d.size.height)).into(),
                })?;
                platform.set_visible(true)?;
                Ok(())
            }

            pub(super) fn set_visible(&self, visible: bool) -> anyhow::Result<()> {
                self.surface.platform_surface()?.set_visible(visible)
            }

            /// Removes the surface, after the web view's own windows went
            /// (later: a view may go while GPUI's app is borrowed).
            pub(super) fn release(self, webview: Rc<wry::WebView>) {
                self.cx
                    .clone()
                    .spawn(async move |cx| {
                        drop(webview);
                        // GTK destroys the web view's X windows from its
                        // loop: let it, before their parent goes (an X
                        // error on a destroyed window aborts GTK).
                        while gtk::events_pending() {
                            gtk::main_iteration_do(false);
                        }
                        cx.background_executor().timer(RELEASE_DELAY).await;
                        while gtk::events_pending() {
                            gtk::main_iteration_do(false);
                        }
                        let removed = self.window.update(cx, |_, window, _| {
                            window
                                .enable_window_composition()?
                                .remove_surface(self.surface.id())
                        });
                        if let Ok(Err(err)) = removed {
                            log::warn!("web view: cannot remove its surface: {err:#}");
                        }
                    })
                    .detach();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_js_strings() {
        assert_eq!(js_string("a\"b\\c\nd"), r#""a\"b\\c\nd""#);
        assert_eq!(js_string("\u{1}"), r#""\u0001""#);
        assert!(post_message("hi").contains(r#"data: "hi""#));
    }

    #[test]
    fn wraps_injected_scripts() {
        let js = after_content("go()");
        assert!(js.contains("go()"));
        assert!(js.contains("DOMContentLoaded"));
    }

    #[test]
    fn parses_navigation_state() {
        let state = Navigation::parse(r#"["https://a.com/","A",true,false]"#, false).unwrap();
        assert_eq!(
            state,
            Navigation {
                url: "https://a.com/".into(),
                title: "A".into(),
                loading: false,
                can_go_back: true,
                can_go_forward: false,
            }
        );
        assert_eq!(Navigation::parse("null", false), None);
    }

    #[test]
    fn allows_app_pages() {
        assert!(always_allowed("data:text/html,hi"));
        assert!(always_allowed("about:blank"));
        assert!(!always_allowed("https://example.com"));
    }
}
